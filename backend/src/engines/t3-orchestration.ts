import type { EngineId } from "../db/schema";
import { DEFAULT_CODEX_MODEL, DEFAULT_OPENCODE_MODEL } from "../runs/model-policy";
import type { EmitStep, EngineRunContext } from "./types";
import type { ProviderEventInput } from "../runs/provider-events";
import { questionEventId, type ProviderQuestionRequest } from "./provider-question";
import { approvalEventId, t3ApprovalRequest } from "./t3-approval";

export type T3EngineId = Extract<EngineId, "codex" | "claude" | "opencode">;
export type T3RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

export interface T3Message {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly turnId: string | null;
  readonly streaming: boolean;
}

export interface T3Activity {
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
export function t3ActivityRevision(activity: T3Activity): string {
  return activity.sequence === undefined
    ? JSON.stringify(activity)
    : String(activity.sequence);
}

function t3ToolCallId(activity: T3Activity): string | null {
  if (!activity.kind.startsWith("tool.")) return null;
  const payload = record(activity.payload);
  const data = record(payload?.data);
  const item = record(data?.item);
  return firstNonEmptyString(data?.toolCallId, item?.id, payload?.toolUseId);
}

function firstNonEmptyString(...values: readonly unknown[]): string | null {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  ) ?? null;
}

/**
 * T3 deliberately keeps provider-native tool records lossless. Codex MCP calls
 * arrive under `data.item`, while other providers expose their identity at the
 * activity payload or data level. Normalize those transport shapes here so the
 * rest of Skynet renders one provider-neutral tool contract.
 */
function t3ToolProjection(activity: T3Activity): {
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly item: Readonly<Record<string, unknown>> | null;
  readonly server: string | null;
  readonly tool: string | null;
  readonly input: unknown;
} {
  const payload = record(activity.payload);
  const data = record(payload?.data);
  const item = record(data?.item);
  return {
    data,
    item,
    server: firstNonEmptyString(payload?.server, data?.server, item?.server),
    tool: firstNonEmptyString(
      payload?.toolName,
      payload?.tool,
      data?.toolName,
      data?.tool,
      item?.tool,
      item?.name,
    ),
    input: item?.arguments ?? data ?? activity.payload,
  };
}

/**
 * T3 emits a new activity id for each lifecycle revision of a provider tool.
 * Prefer the provider's stable call id so one tool/subagent renders as one
 * evolving row instead of a started/updated/completed row fan-out.
 */
export function t3ActivityStepKey(activity: T3Activity): string {
  if (activity.kind.startsWith("task.")) {
    const payload = record(activity.payload);
    if (typeof payload?.taskId === "string" && payload.taskId.length > 0) {
      return `task:${payload.taskId}`;
    }
  }
  const toolCallId = t3ToolCallId(activity);
  return toolCallId ? `tool:${toolCallId}` : `activity:${activity.id}`;
}

/** T3 emits provider collaboration wrappers in addition to the authoritative
 * task lifecycle for providers with native child-agent events. OpenCode may
 * expose only the collaboration tool lifecycle, so retain that row unless a
 * task lifecycle with the same provider tool-use id is present. */
export function shouldProjectT3Activity(
  activity: T3Activity,
  activities: readonly T3Activity[] = [],
): boolean {
  if (!activity.kind.startsWith("tool.")) return true;
  const payload = record(activity.payload);
  if (payload?.itemType !== "collab_agent_tool_call") return true;
  const toolCallId = t3ToolCallId(activity);
  if (!toolCallId) return true;
  return !activities.some((candidate) => {
    if (!candidate.kind.startsWith("task.")) return false;
    const candidatePayload = record(candidate.payload);
    return candidatePayload?.toolUseId === toolCallId;
  });
}

export interface T3ThreadSnapshot {
  readonly snapshotSequence: number;
  readonly thread: {
    readonly id: string;
    readonly latestTurn: null | {
      readonly turnId: string;
      readonly state: "running" | "interrupted" | "completed" | "error";
      readonly assistantMessageId: string | null;
    };
    readonly messages: readonly T3Message[];
    readonly activities: readonly T3Activity[];
    readonly session: null | {
      readonly status: string;
      readonly lastError: string | null;
    };
  };
}

const PROVIDER_INSTANCE: Record<T3EngineId, string> = {
  codex: "codex",
  claude: "claudeAgent",
  opencode: "opencode",
};

const DEFAULT_MODEL: Record<T3EngineId, string> = {
  codex: DEFAULT_CODEX_MODEL,
  claude: "claude-opus-5",
  opencode: DEFAULT_OPENCODE_MODEL,
};

/**
 * Skynet stores OpenCode models in its product-facing catalog without the
 * OpenCode provider-instance prefix: Anthropic ids are bare, while OpenRouter
 * ids retain their upstream vendor prefix. T3's native OpenCode adapter accepts
 * only `provider/model` selections, so translate at this one transport boundary.
 */
export function t3ModelId(engine: T3EngineId, requested?: string): string {
  const selected = requested?.trim() || DEFAULT_MODEL[engine];
  if (engine !== "opencode") return selected;
  if (selected.startsWith("anthropic/") || selected.startsWith("openrouter/")) {
    return selected;
  }
  return selected.includes("/") ? `openrouter/${selected}` : `anthropic/${selected}`;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${value}`.replace(/[^a-zA-Z0-9._~-]/g, "-");
}

function t3PlanTodos(value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
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

export function t3ProjectId(ctx: Pick<EngineRunContext, "threadId" | "runId">): string {
  return stableId("skynet-project", ctx.threadId ?? ctx.runId);
}

export function t3ThreadId(ctx: Pick<EngineRunContext, "threadId" | "runId">): string {
  return stableId("skynet-thread", ctx.threadId ?? ctx.runId);
}

export function buildT3ProjectCreateCommand(
  ctx: Pick<EngineRunContext, "threadId" | "runId">,
  workspaceRoot: string,
  createdAt: string,
): Readonly<Record<string, unknown>> {
  const projectId = t3ProjectId(ctx);
  return {
    type: "project.create",
    commandId: stableId("skynet-project-create", ctx.runId),
    projectId,
    title: `Skynet ${ctx.threadId ?? ctx.runId}`,
    workspaceRoot,
    createdAt,
  };
}

export function buildT3ThreadCreateCommand(
  ctx: Pick<EngineRunContext, "threadId" | "runId" | "model">,
  engine: T3EngineId,
  createdAt: string,
  runtimeMode: T3RuntimeMode = "full-access",
): Readonly<Record<string, unknown>> {
  const modelSelection = {
    instanceId: PROVIDER_INSTANCE[engine],
    model: t3ModelId(engine, ctx.model),
    options: [],
  };
  return {
    type: "thread.create",
    commandId: stableId("skynet-thread-create", ctx.runId),
    threadId: t3ThreadId(ctx),
    projectId: t3ProjectId(ctx),
    title: `Skynet ${ctx.threadId ?? ctx.runId}`,
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  };
}

export function buildT3TurnStartCommand(
  ctx: Pick<EngineRunContext, "threadId" | "runId" | "model">,
  engine: T3EngineId,
  prompt: string,
  createdAt: string,
  createThread: boolean,
  runtimeMode: T3RuntimeMode = "full-access",
): Readonly<Record<string, unknown>> {
  const projectId = t3ProjectId(ctx);
  const threadId = t3ThreadId(ctx);
  const modelSelection = {
    instanceId: PROVIDER_INSTANCE[engine],
    model: t3ModelId(engine, ctx.model),
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
              title: `Skynet ${ctx.threadId ?? ctx.runId}`,
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

export function buildT3TurnInterruptCommand(
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

export function isT3ThreadSessionId(sessionId: string): boolean {
  return sessionId.startsWith("skynet-thread-");
}

export function assistantText(snapshot: T3ThreadSnapshot): string {
  const messageId = snapshot.thread.latestTurn?.assistantMessageId;
  const matching = messageId
    ? snapshot.thread.messages.find((message) => message.id === messageId)
    : undefined;
  if (matching?.role === "assistant") return matching.text;
  return snapshot.thread.messages.findLast((message) => message.role === "assistant")?.text ?? "";
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
  activity: T3Activity,
  payload: Readonly<Record<string, unknown>>,
  isAgent: boolean,
): string {
  const taskId = descriptiveActivityLabel(payload.taskId);
  return descriptiveActivityLabel(payload.title) ??
    descriptiveActivityLabel(payload.role) ??
    taskId?.replaceAll(/[_-]+/gu, " ") ??
    descriptiveActivityLabel(activity.summary) ??
    (isAgent ? "Subagent" : "Task");
}

function toolActivityLabel(
  activity: T3Activity,
  projection: ReturnType<typeof t3ToolProjection>,
  tool: string,
): string {
  if (projection.server && projection.tool) return `${projection.server} · ${projection.tool}`;
  return descriptiveActivityLabel(activity.summary) ??
    descriptiveActivityLabel(projection.tool) ??
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
      return "websearch";
    default:
      return itemType ?? "tool";
  }
}

export function activityStep(activity: T3Activity): EmitStep {
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
        input: { todos: t3PlanTodos(payload?.plan) },
        ...(typeof payload?.explanation === "string"
          ? { output: payload.explanation }
          : {}),
      },
    };
  }
  if (activity.kind.startsWith("task.")) {
    const isAgent = payload?.agentKind === "agent";
    const taskId = typeof payload?.taskId === "string" ? payload.taskId : undefined;
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
    const projection = t3ToolProjection(activity);
    const toolCallId = t3ToolCallId(activity);
    const childSessionId = isSubagent && detail
      ? /<task\s+id="([^"]+)"/u.exec(detail)?.[1] ?? null
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
        error: activity.tone === "error" || activity.kind === "tool.denied",
        native: {
          sessionID: typeof payload?.taskId === "string" ? payload.taskId : undefined,
          callID: toolCallId ?? (
            typeof payload?.toolUseId === "string" ? payload.toolUseId : undefined
          ),
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

export function t3QuestionRequest(
  activity: T3Activity,
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

export function t3ActivityProviderEvent(
  ctx: Pick<EngineRunContext, "runId" | "threadId">,
  sessionId: string,
  activity: T3Activity,
): ProviderEventInput {
  const question = t3QuestionRequest(activity, sessionId);
  const approval = t3ApprovalRequest(activity, sessionId);
  const payload = record(activity.payload);
  const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
  const taskId = typeof payload?.taskId === "string" ? payload.taskId : null;
  const parentAgentId = typeof payload?.parentAgentId === "string"
    ? payload.parentAgentId
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
    nativeSessionId: sessionId,
    nativeParentSessionId: parentAgentId,
    nativePartId: activity.id,
    nativeCallId: activity.kind.startsWith("task.") ? taskId : null,
    payload: approval ?? question ?? (
      activity.kind === "approval.resolved" && requestId
        ? { requestId, ...payload }
        : activity.kind === "user-input.resolved" && requestId
          ? { requestID: requestId, ...payload }
          : activity
    ),
  };
}

export function t3TurnSettled(snapshot: T3ThreadSnapshot): boolean {
  const state = snapshot.thread.latestTurn?.state;
  return state === "completed" || state === "interrupted" || state === "error";
}

export function t3TurnError(snapshot: T3ThreadSnapshot): string | null {
  if (snapshot.thread.latestTurn?.state !== "error") return null;
  return snapshot.thread.session?.lastError ?? "T3 provider turn failed";
}
