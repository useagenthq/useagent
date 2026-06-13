import type { EngineId } from "../db/schema";
import { DEFAULT_CODEX_MODEL, DEFAULT_OPENCODE_MODEL } from "../runs/model-policy";
import type { EmitStep, EngineRunContext } from "./types";
import type { ProviderEventInput } from "../runs/provider-events";
import type { SecretRedactor } from "../secrets/redact";
import {
  questionEventId,
  redactProviderQuestionPayload,
  type ProviderQuestionRequest,
} from "./provider-question";
import { approvalEventId, runtimeApprovalRequest } from "./runtime-approval";
import {
  firstSemanticT3ToolName,
  t3SummaryToolIdentity,
  t3TaskDisplayTitle,
} from "@useagent/agent-harness";
import { toolServerDisplayName } from "@useagent/agent-harness/canonical";

export type RuntimeEngineId = Extract<EngineId, "codex" | "claude" | "opencode">;
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export interface RuntimeMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming: boolean;
}
export interface RuntimeActivity {
  readonly id: string;
  readonly tone: "info" | "tool" | "approval" | "error";
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly turnId: string | null;
  readonly sequence?: number;
}

/**
 * T3 keeps several activity rows (notably task.progress) under a stable id and
 * replaces their payload as the provider reports newer state. The adapter must
 * therefore dedupe by revision, never by id alone.
 */
export function runtimeActivityRevision(activity: RuntimeActivity): string {
  return activity.sequence === undefined
    ? JSON.stringify(activity)
    : String(activity.sequence);
}

/**
 * Provider tool identity precedence: data.toolCallId, payload.toolCallId,
 * data.item.id, payload/data call-id aliases, tool-use aliases, then payload.id.
 * Durable consumers fall back to activity.id only after this list. Keep this
 * mirrored by the canonical T3 translator so both lanes name the same call.
 */
function runtimeToolCallId(activity: RuntimeActivity): string | null {
  if (!activity.kind.startsWith("tool.")) return null;
  const payload = record(activity.payload);
  const data = record(payload?.data);
  const item = record(data?.item);
  return firstNonEmptyString(
    data?.toolCallId,
    payload?.toolCallId,
    item?.id,
    data?.callId,
    data?.callID,
    payload?.callId,
    payload?.callID,
    payload?.toolUseId,
    data?.toolUseId,
    payload?.id,
  );
}

function firstNonEmptyString(...values: readonly unknown[]): string | null {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  ) ?? null;
}

function runtimeToolInput(
  payload: Readonly<Record<string, unknown>> | null,
  data: Readonly<Record<string, unknown>> | null,
  item: Readonly<Record<string, unknown>> | null,
): unknown {
  return item?.arguments ??
    data?.arguments ??
    data?.input ??
    payload?.arguments ??
    payload?.input ??
    data ??
    payload;
}

/**
 * T3 deliberately keeps provider-native tool records lossless. Codex MCP calls
 * arrive under `data.item`, while other providers expose their identity at the
 * activity payload or data level. Normalize those transport shapes here so the
 * rest of useAgent renders one provider-neutral tool contract.
 */
function runtimeToolProjection(activity: RuntimeActivity): {
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly item: Readonly<Record<string, unknown>> | null;
  readonly server: string | null;
  readonly tool: string | null;
  readonly input: unknown;
} {
  const payload = record(activity.payload);
  const data = record(payload?.data);
  const item = record(data?.item);
  const summaryIdentity = t3SummaryToolIdentity(activity.summary);
  const tool = firstSemanticT3ToolName(
    payload?.toolName,
    data?.toolName,
    item?.toolName,
    payload?.tool,
    data?.tool,
    item?.tool,
    item?.name,
    item?.title,
    summaryIdentity?.tool,
  );
  return {
    data,
    item,
    server: firstNonEmptyString(
      payload?.server,
      data?.server,
      item?.server,
      summaryIdentity?.server,
    ),
    tool,
    input: runtimeToolInput(payload, data, item),
  };
}

const RUNTIME_TOOL_FAILURE_STATUSES = new Set([
  "declined",
  "denied",
  "error",
  "failed",
  "rejected",
]);

function runtimeToolResultFailed(activity: RuntimeActivity): boolean {
  if (activity.kind !== "tool.completed") return false;
  const payload = record(activity.payload);
  const data = record(payload?.data);
  const item = record(data?.item);
  if ([payload?.status, data?.status, item?.status].some(
    (status) => typeof status === "string" && RUNTIME_TOOL_FAILURE_STATUSES.has(status.toLowerCase()),
  )) {
    return true;
  }
  if ([payload?.error, data?.error, item?.error].some(
    (error) => error !== undefined && error !== null && error !== false && error !== "",
  )) {
    return true;
  }
  return [payload?.result, data?.result, item?.result].some((value) => {
    const result = record(value);
    return result?.isError === true || (
      result?.error !== undefined && result.error !== null && result.error !== false
    );
  });
}

function runtimeChildSessionId(activity: RuntimeActivity): string | null {
  const payload = record(activity.payload);
  const data = record(payload?.data);
  const item = record(data?.item);
  const direct = firstNonEmptyString(
    payload?.childSessionId,
    payload?.childSessionID,
    data?.childSessionId,
    data?.childSessionID,
    item?.childSessionId,
    item?.childSessionID,
  );
  if (direct) return direct;
  const detail = typeof payload?.detail === "string" ? payload.detail : null;
  return detail ? /<task\s+id="([^"]+)"/u.exec(detail)?.[1] ?? null : null;
}

/**
 * T3 emits a new activity id for each lifecycle revision of a provider tool.
 * Prefer the provider's stable call id so one tool/subagent renders as one
 * evolving row instead of a started/updated/completed row fan-out.
 */
export function runtimeActivityStepKey(activity: RuntimeActivity): string {
  if (activity.kind.startsWith("task.")) {
    const payload = record(activity.payload);
    if (typeof payload?.taskId === "string" && payload.taskId.length > 0) {
      return `task:${payload.taskId}`;
    }
  }
  const toolCallId = runtimeToolCallId(activity);
  return toolCallId ? `tool:${toolCallId}` : `activity:${activity.id}`;
}

/**
 * Is any provider tool call still in flight? A call is open when its latest
 * lifecycle revision (tool.started / tool.updated) has no later terminal
 * revision (tool.completed / tool.denied, or an error tone) for the same call
 * id. A long-running tool emits NO new activity revisions while it executes,
 * so the turn watchdog must treat an open call as real progress instead of
 * timing out a healthy install or build as "no provider activity".
 */
export function hasOpenRuntimeToolCall(activities: readonly RuntimeActivity[]): boolean {
  const latestKindByCall = new Map<string, RuntimeActivity>();
  for (const activity of activities) {
    if (!activity.kind.startsWith("tool.")) continue;
    const key = runtimeToolCallId(activity) ?? activity.id;
    latestKindByCall.set(key, activity);
  }
  for (const activity of latestKindByCall.values()) {
    if (activity.tone === "error") continue;
    if (activity.kind === "tool.completed" || activity.kind === "tool.denied") continue;
    return true;
  }
  return false;
}

/** T3 emits provider collaboration wrappers in addition to the authoritative
 * task lifecycle for providers with native child-agent events. OpenCode may
 * expose only the collaboration tool lifecycle, so retain that row unless a
 * task lifecycle with the same provider tool-use id is present. */
export function shouldProjectRuntimeActivity(
  activity: RuntimeActivity,
  activities: readonly RuntimeActivity[] = [],
): boolean {
  const payload = record(activity.payload);
  if (payload?.timelineBypass === true && !activity.kind.startsWith("task.")) return false;
  if (!activity.kind.startsWith("tool.")) return true;
  const itemType = typeof payload?.itemType === "string" ? payload.itemType : null;
  if (
    (itemType === "dynamic_tool_call" || itemType === "mcp_tool_call") &&
    !runtimeToolProjection(activity).tool
  ) {
    // A completed transport wrapper with no semantic tool identity is still
    // useful in the provider-event ledger, but it cannot produce a meaningful
    // or reconcilable UI row. Do not expose generic "Mcp tool call" noise.
    return false;
  }
  const toolCallId = runtimeToolCallId(activity);
  if (
    !toolCallId &&
    (activity.kind.endsWith(".started") ||
      activity.kind.endsWith(".updated") ||
      activity.kind.endsWith(".progress"))
  ) {
    // T3 preserves these transport notifications in provider_events, but a
    // provisional row without producer identity cannot be reconciled safely
    // with its eventual completion. Projecting it creates duplicate/flickering
    // UI rows and can merge concurrent calls by label, so wait for an
    // identified revision before adding it to the durable step timeline.
    return false;
  }
  if (payload?.itemType !== "collab_agent_tool_call") return true;
  const agentTasks = activities.filter((candidate) => {
    if (!candidate.kind.startsWith("task.")) return false;
    const candidatePayload = record(candidate.payload);
    return candidatePayload?.agentKind === "agent" && firstNonEmptyString(
      candidatePayload.taskId,
      candidatePayload.childSessionId,
      candidatePayload.childSessionID,
    ) !== null;
  });
  if (!toolCallId) {
    // Codex can emit an identity-less collaboration completion after already
    // publishing the authoritative child task lifecycle. Once that lifecycle
    // exists, the wrapper is transport noise and cannot be reconciled safely.
    // Providers that expose only the collaboration wrapper still retain it.
    return agentTasks.length === 0;
  }
  return !agentTasks.some((candidate) => {
    const candidatePayload = record(candidate.payload);
    const childSessionId = firstNonEmptyString(
      candidatePayload?.taskId,
      candidatePayload?.childSessionId,
      candidatePayload?.childSessionID,
    );
    return childSessionId !== null && candidatePayload?.toolUseId === toolCallId;
  });
}

export interface RuntimeThreadSnapshot {
  readonly snapshotSequence: number;
  readonly thread: {
    readonly id: string;
    readonly latestTurn: null | {
      readonly turnId: string;
      readonly state: "running" | "interrupted" | "completed" | "error";
      readonly assistantMessageId: string | null;
    };
    readonly messages: readonly RuntimeMessage[];
    readonly activities: readonly RuntimeActivity[];
    readonly session: null | {
      readonly status: string;
      readonly lastError: string | null;
    };
  };
}

const PROVIDER_INSTANCE: Record<RuntimeEngineId, string> = {
  codex: "codex",
  claude: "claudeAgent",
  opencode: "opencode",
};

const DEFAULT_MODEL: Record<RuntimeEngineId, string> = {
  codex: DEFAULT_CODEX_MODEL,
  claude: "claude-opus-5",
  opencode: DEFAULT_OPENCODE_MODEL,
};

/**
 * useAgent stores OpenCode models in its product-facing catalog without an
 * OpenCode provider-instance prefix for Anthropic and most OpenRouter ids.
 * OpenAI-native ids keep their `openai/` provider prefix so T3 can spend a
 * connected OpenAI key instead of routing through OpenRouter.
 */
export function runtimeModelId(engine: RuntimeEngineId, requested?: string): string {
  const selected = requested?.trim() || DEFAULT_MODEL[engine];
  if (engine !== "opencode") return selected;
  if (
    selected.startsWith("anthropic/") ||
    selected.startsWith("openai/") ||
    selected.startsWith("openrouter/")
  ) {
    return selected;
  }
  return selected.includes("/") ? `openrouter/${selected}` : `anthropic/${selected}`;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${value}`.replace(/[^a-zA-Z0-9._~-]/g, "-");
}

function runtimePlanTodos(value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = record(raw);
    if (typeof item?.step !== "string") return [];
    return [{
      content: item.step,
      status: item.status === "inProgress" ? "in_progress" : item.status,
    }];
  });
}

export function runtimeProjectId(ctx: Pick<EngineRunContext, "threadId" | "runId">): string {
  return stableId("skynet-project", ctx.threadId ?? ctx.runId);
}

export function runtimeThreadId(ctx: Pick<EngineRunContext, "threadId" | "runId">): string {
  return stableId("skynet-thread", ctx.threadId ?? ctx.runId);
}

export function buildRuntimeProjectCreateCommand(
  ctx: Pick<EngineRunContext, "threadId" | "runId">,
  workspaceRoot: string,
  createdAt: string,
): Readonly<Record<string, unknown>> {
  const projectId = runtimeProjectId(ctx);
  return {
    type: "project.create",
    commandId: stableId("skynet-project-create", ctx.runId),
    projectId,
    title: `useAgent ${ctx.threadId ?? ctx.runId}`,
    workspaceRoot,
    createdAt,
  };
}

export function buildRuntimeThreadCreateCommand(
  ctx: Pick<EngineRunContext, "threadId" | "runId" | "model">,
  engine: RuntimeEngineId,
  createdAt: string,
  runtimeMode: RuntimeMode = "full-access",
): Readonly<Record<string, unknown>> {
  const modelSelection = {
    instanceId: PROVIDER_INSTANCE[engine],
    model: runtimeModelId(engine, ctx.model),
    options: [],
  };
  return {
    type: "thread.create",
    commandId: stableId("skynet-thread-create", ctx.runId),
    threadId: runtimeThreadId(ctx),
    projectId: runtimeProjectId(ctx),
    title: `useAgent ${ctx.threadId ?? ctx.runId}`,
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  };
}

export function buildRuntimeTurnStartCommand(
  ctx: Pick<EngineRunContext, "threadId" | "runId" | "model">,
  engine: RuntimeEngineId,
  prompt: string,
  createdAt: string,
  createThread: boolean,
  runtimeMode: RuntimeMode = "full-access",
): Readonly<Record<string, unknown>> {
  const projectId = runtimeProjectId(ctx);
  const threadId = runtimeThreadId(ctx);
  const modelSelection = {
    instanceId: PROVIDER_INSTANCE[engine],
    model: runtimeModelId(engine, ctx.model),
    options: [],
  };
  return {
    type: "thread.turn.start",
    commandId: stableId("skynet-turn", ctx.runId),
    threadId,
    message: {
      messageId: stableId("skynet-message", ctx.runId),
      role: "user",
      text: prompt,
      attachments: [],
    },
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    ...(createThread
      ? {
          bootstrap: {
            createThread: {
              projectId,
              title: `useAgent ${ctx.threadId ?? ctx.runId}`,
              modelSelection,
              runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
        }
      : {}),
    createdAt,
  };
}

export function buildRuntimeTurnInterruptCommand(
  threadId: string,
  turnId?: string,
  createdAt = new Date().toISOString(),
): Readonly<Record<string, unknown>> {
  return {
    type: "thread.turn.interrupt",
    commandId: stableId("skynet-turn-interrupt", crypto.randomUUID()),
    threadId,
    ...(turnId ? { turnId } : {}),
    createdAt,
  };
}

export function isRuntimeThreadSessionId(sessionId: string): boolean {
  return sessionId.startsWith("skynet-thread-");
}

export function assistantText(snapshot: RuntimeThreadSnapshot): string {
  const latestTurn = snapshot.thread.latestTurn;
  if (!latestTurn) return "";
  const messageId = latestTurn.assistantMessageId;
  const matching = messageId
    ? snapshot.thread.messages.find((message) => message.id === messageId)
    : undefined;
  if (matching?.role === "assistant" && matching.turnId === latestTurn.turnId) {
    return matching.text;
  }
  return snapshot.thread.messages.findLast(
    (message) => message.role === "assistant" && message.turnId === latestTurn.turnId,
  )?.text ?? "";
}

const TRANSPORT_PLACEHOLDER_LABELS = new Set([
  "mcp tool call",
  "subagent",
  "subagent started",
  "task",
  "task started",
  "tool",
  "tool started",
]);

function descriptiveActivityLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label && !TRANSPORT_PLACEHOLDER_LABELS.has(label.toLowerCase()) ? label : null;
}

function taskActivityLabel(
  activity: RuntimeActivity,
  payload: Readonly<Record<string, unknown>>,
  isAgent: boolean,
): string {
  return t3TaskDisplayTitle({
    title: payload.title,
    role: payload.role,
    taskId: payload.taskId,
    summary: activity.summary,
    agent: isAgent,
  });
}

function toolActivityLabel(
  activity: RuntimeActivity,
  projection: ReturnType<typeof runtimeToolProjection>,
  tool: string,
): string {
  if (projection.server && projection.tool) {
    return `${toolServerDisplayName(projection.server)} · ${projection.tool}`;
  }
  return descriptiveActivityLabel(projection.tool) ??
    descriptiveActivityLabel(activity.summary) ??
    descriptiveActivityLabel(tool) ??
    "Tool";
}

function toolActivityName(
  itemType: string | null,
  projectedTool: string | null,
  isSubagent: boolean,
): string {
  if (isSubagent) return "subagent";
  if (projectedTool) return projectedTool;
  switch (itemType) {
    case "command_execution":
      return "bash";
    case "file_change":
      return "edit";
    case "web_search":
      return "web_search";
    default:
      return itemType ?? "tool";
  }
}

// The literal "t3" source tag in step code_json below is a frozen stored VALUE:
// historical steps carry it and the frontend matches on it.
export function activityStep(activity: RuntimeActivity, rootSessionId?: string): EmitStep {
  const payload = record(activity.payload);
  const detail = typeof payload?.detail === "string" ? payload.detail : undefined;
  if (activity.kind === "turn.plan.updated") {
    return {
      kind: "command",
      label: activity.summary,
      chip: "plan",
      code_json: {
        source: "t3",
        activityId: activity.id,
        activityKind: activity.kind,
        tool: "todowrite",
        input: { todos: runtimePlanTodos(payload?.plan) },
        ...(typeof payload?.explanation === "string"
          ? { output: payload.explanation }
          : {}),
      },
    };
  }
  if (activity.kind.startsWith("task.")) {
    const isAgent = payload?.agentKind === "agent";
    const taskId = typeof payload?.taskId === "string" ? payload.taskId : undefined;
    const parentSessionId = runtimeChildParentSessionId(payload, rootSessionId);
    const title = taskActivityLabel(activity, payload ?? {}, isAgent);
    return {
      kind: "task",
      label: title,
      chip: isAgent ? "subagent" : activity.kind,
      code_json: {
        source: "t3",
        activityId: activity.id,
        activityKind: activity.kind,
        tool: isAgent ? "subagent" : "task",
        input: {
          description: title,
          ...(detail ? { prompt: detail } : {}),
        },
        ...(typeof payload?.summary === "string" ? { output: payload.summary } : {}),
        ...(typeof payload?.status === "string" ? { status: payload.status } : {}),
        ...(payload?.typedUsage !== undefined ? { usage: payload.typedUsage } : {}),
        error: activity.tone === "error",
        native: {
          sessionID: isAgent ? taskId : undefined,
          parentSessionID: isAgent ? parentSessionId ?? undefined : undefined,
          callID: taskId,
          childSessionID: isAgent ? taskId : undefined,
          activity: activity.payload,
        },
      },
    };
  }
  if (activity.kind.startsWith("tool.")) {
    const itemType = typeof payload?.itemType === "string" ? payload.itemType : null;
    const isSubagent = itemType === "collab_agent_tool_call";
    const projection = runtimeToolProjection(activity);
    const toolCallId = runtimeToolCallId(activity);
    const childSessionId = isSubagent ? runtimeChildSessionId(activity) : null;
    const attributedChildId = runtimeAttributedChildId(activity, payload);
    const attributedParentId = attributedChildId
      ? runtimeAttributedChildParentSessionId(activity, payload, rootSessionId)
      : null;
    const tool = toolActivityName(itemType, projection.tool, isSubagent);
    return {
      kind: itemType === "file_change" ? "file" : isSubagent ? "task" : "command",
      label: toolActivityLabel(activity, projection, tool),
      chip: isSubagent ? "subagent" : itemType === "web_search" ? "search" : activity.kind,
      code_json: {
        source: "t3",
        activityId: activity.id,
        activityKind: activity.kind,
        tool,
        input: projection.input,
        ...(projection.server ? { server: projection.server } : {}),
        ...(detail ? { output: detail } : {}),
        error: activity.tone === "error" ||
          activity.kind === "tool.denied" ||
          runtimeToolResultFailed(activity),
        native: {
          sessionID: attributedChildId ?? (
            typeof payload?.taskId === "string" ? payload.taskId : undefined
          ),
          parentSessionID: attributedParentId ?? undefined,
          callID: toolCallId ?? activity.id,
          childSessionID: childSessionId ?? undefined,
          activity: activity.payload,
        },
      },
    };
  }
  return {
    kind: "task",
    label: activity.summary,
    chip: activity.tone === "error" ? "error" : activity.kind,
    code_json: {
      source: "t3",
      activityId: activity.id,
      activityKind: activity.kind,
      tone: activity.tone,
      payload: activity.payload,
      error: activity.tone === "error",
    },
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function runtimeChildParentSessionId(
  payload: Readonly<Record<string, unknown>> | null,
  rootSessionId?: string,
): string | null {
  return firstNonEmptyString(
    payload?.parentAgentId,
    payload?.agentId,
    rootSessionId,
  );
}

function runtimeAttributedChildParentSessionId(
  activity: RuntimeActivity,
  payload: Readonly<Record<string, unknown>> | null,
  rootSessionId?: string,
): string | null {
  if (activity.kind.startsWith("task.") && payload?.agentKind === "agent") {
    return runtimeChildParentSessionId(payload, rootSessionId);
  }
  return firstNonEmptyString(payload?.parentAgentId, rootSessionId);
}

function runtimeAttributedChildId(
  activity: RuntimeActivity,
  payload: Readonly<Record<string, unknown>> | null,
): string | null {
  if (activity.kind.startsWith("task.") && payload?.agentKind === "agent") {
    return firstNonEmptyString(payload.taskId);
  }
  if (payload?.timelineBypass === true) {
    return firstNonEmptyString(payload.childSessionId, payload.agentId);
  }
  return null;
}

export function runtimeQuestionRequest(
  activity: RuntimeActivity,
  sessionId: string,
): ProviderQuestionRequest | null {
  if (activity.kind !== "user-input.requested") return null;
  const payload = record(activity.payload);
  if (!payload || typeof payload.requestId !== "string" || !Array.isArray(payload.questions)) {
    return null;
  }
  const questions = payload.questions.flatMap((raw) => {
    const question = record(raw);
    if (
      !question ||
      typeof question.id !== "string" ||
      typeof question.header !== "string" ||
      typeof question.question !== "string" ||
      !Array.isArray(question.options)
    ) {
      return [];
    }
    const options = question.options.flatMap((rawOption) => {
      const option = record(rawOption);
      return option && typeof option.label === "string" && typeof option.description === "string"
        ? [{ label: option.label, description: option.description }]
        : [];
    });
    if (options.length !== question.options.length) return [];
    return [{
      question: question.question,
      header: question.header,
      options,
      multiple: question.multiSelect === true,
      custom: true,
    }];
  });
  if (questions.length === 0 || questions.length !== payload.questions.length) return null;
  return { id: payload.requestId, sessionID: sessionId, questions };
}

// provider "t3", the "t3.activity." event-type prefix, and the pe_.._t3_ id
// scheme are frozen stored VALUES in the provider_events ledger.
export function runtimeActivityProviderEvent(
  ctx: Pick<EngineRunContext, "runId" | "threadId">,
  sessionId: string,
  activity: RuntimeActivity,
  redact: Pick<SecretRedactor, "text" | "unknown">,
): ProviderEventInput {
  const question = runtimeQuestionRequest(activity, sessionId);
  const approval = runtimeApprovalRequest(activity, sessionId);
  const payload = record(activity.payload);
  const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
  const taskId = typeof payload?.taskId === "string" ? payload.taskId : null;
  const attributedChildId = runtimeAttributedChildId(activity, payload);
  const childOwned = attributedChildId !== null;
  const nativeSessionId = attributedChildId ?? sessionId;
  const nativeParentSessionId = childOwned
    ? runtimeAttributedChildParentSessionId(activity, payload, sessionId)
    : firstNonEmptyString(payload?.parentAgentId);
  const nativeMessageId = activity.kind.startsWith("child.message.")
    ? firstNonEmptyString(payload?.messageId, payload?.itemId)
    : null;
  const eventType = approval
    ? "approval.requested"
    : activity.kind === "approval.resolved" && requestId
      ? "approval.resolved"
      : question
    ? "question.asked"
    : activity.kind === "user-input.resolved" && requestId
      ? "question.replied"
      : `t3.activity.${activity.kind}`;
  return {
    id: approval
      ? approvalEventId(ctx.runId, approval.id, "requested")
      : activity.kind === "approval.resolved" && requestId
        ? approvalEventId(ctx.runId, requestId, "resolved")
        : question
      ? questionEventId(ctx.runId, question.id, "asked")
      : activity.kind === "user-input.resolved" && requestId
        ? questionEventId(ctx.runId, requestId, "replied")
        : `pe_${ctx.runId}_t3_${activity.id}`,
    runId: ctx.runId,
    threadId: ctx.threadId ?? ctx.runId,
    provider: "t3",
    eventType,
    nativeSessionId,
    nativeParentSessionId,
    nativeMessageId,
    nativePartId: activity.id,
    nativeCallId: activity.kind.startsWith("task.")
      ? taskId
      : activity.kind.startsWith("tool.")
        ? runtimeToolCallId(activity)
        : null,
    payload: question
      ? redactProviderQuestionPayload(question, redact)
      : activity.kind === "user-input.resolved" && requestId
        ? redactProviderQuestionPayload({ requestID: requestId, ...payload }, redact)
        : redact.unknown(approval ?? (
          activity.kind === "approval.resolved" && requestId
            ? { requestId, ...payload }
            : activity
        )),
  };
}

export function runtimeTurnSettled(snapshot: RuntimeThreadSnapshot): boolean {
  const state = snapshot.thread.latestTurn?.state;
  return state === "completed" || state === "interrupted" || state === "error";
}

export function runtimeTurnError(snapshot: RuntimeThreadSnapshot): string | null {
  if (snapshot.thread.latestTurn?.state !== "error") return null;
  return snapshot.thread.session?.lastError ?? "The provider turn failed";
}
