// The plane's view of a protocol 2 thread, in the shape the turn projector,
// the reply paths and the recorded ledger already read (RuntimeThreadSnapshot).
// Runs become turns, conversation messages keep their run as their turn, and
// typed turn items become the activity revisions the plane records as `t3`
// provider events and steps. So the events the frontend and the canonical
// translator read keep their exact vocabulary; only their source changed.
//
// Activity ids are `<item id>:<phase>` (started, updated, completed): each
// lifecycle phase is its own ledger row, and a later revision of the same
// phase replaces its row (the ledger upserts by id). Every payload carries the
// runtime's own record under `v2`. File diffs never reach the plane: the
// runtime strips them from its wire copy. Command output does, whole up to the
// runtime's wire limit (a longer one comes as `outputOmitted`, without text);
// the record bounds it like any other string (boundedV2Record).
//
// The view keeps every value whole. Only a record point cuts long values
// (recordedRuntimeActivity), and a string is redacted whole before it is cut:
// a cut first could leave part of a secret the redactor no longer recognizes.
import type { SecretRedactor } from "../secrets/redact";
import type { RuntimeActivity, RuntimeMessage, RuntimeThreadSnapshot } from "./runtime-orchestration";
import { v2RunSettled, type V2Projection, type V2Run, type V2ThreadSnapshot, type V2TurnItem } from "./runtime-v2-wire";

type Rec = Readonly<Record<string, unknown>>;
type Turn = NonNullable<RuntimeThreadSnapshot["thread"]["latestTurn"]>;

const DETAIL_LIMIT = 4_000;
/** The runtime's own record rides along bounded: a durable payload over its
 *  byte limit is replaced whole, which would lose the fields the plane reads. */
const RECORD_STRING_LIMIT = 1_000;
const RECORD_ARRAY_LIMIT = 50;
const RECORD_DEPTH_LIMIT = 6;
const RECORD_BYTE_LIMIT = 8_192;
/** Message context and attachments stay with the runtime: the record keeps what the work was, not what was sent. */
const RECORD_OMITTED_KEYS = new Set(["context", "attachments", "attachmentsByQuestionId", "questionAnswer"]);

const record = (value: unknown): Rec | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const time = (value: unknown): number => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

type Redact = Pick<SecretRedactor, "text">;

/** A string within `limit`, redacted whole before it is cut. */
function cut(value: string, limit: number, redact: Redact): string {
  if (value.length <= limit) return value;
  const safe = redact.text(value);
  return safe.length > limit ? `${safe.slice(0, limit - 1)}…` : safe;
}

function boundedValue(value: unknown, depth: number, stringLimit: number, redact: Redact): unknown {
  if (typeof value === "string") return cut(value, stringLimit, redact);
  if (value === null || typeof value !== "object") return value;
  if (depth >= RECORD_DEPTH_LIMIT) return "[nested]";
  if (Array.isArray(value)) {
    const kept = value.slice(0, RECORD_ARRAY_LIMIT).map((entry) => boundedValue(entry, depth + 1, stringLimit, redact));
    return value.length > RECORD_ARRAY_LIMIT ? [...kept, `[${value.length - RECORD_ARRAY_LIMIT} more]`] : kept;
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !RECORD_OMITTED_KEYS.has(key))
    .map(([key, entry]) => [key, boundedValue(entry, depth + 1, stringLimit, redact)]));
}

/** The runtime's record as the payload carries it: long strings cut, long lists
 *  capped, context and attachments left out, and past the byte limit only its identity. */
export function boundedV2Record(value: Rec, redact: Redact): Rec {
  const bounded = boundedValue(value, 0, RECORD_STRING_LIMIT, redact) as Rec;
  if (new TextEncoder().encode(JSON.stringify(bounded)).byteLength <= RECORD_BYTE_LIMIT) return bounded;
  return { id: value.id, type: value.type, status: value.status, truncated: true };
}

/** The tool input a step shows (arguments, a command): every string within the detail limit. */
const BOUNDED_DATA_KEYS = new Set(["arguments", "input", "item"]);

/**
 * An activity as the plane records it (ledger event and step): details and
 * tool input within the detail limit, the runtime's record bounded
 * (boundedV2Record). Everything else is left for the record's own redaction.
 */
export function recordedRuntimeActivity(activity: RuntimeActivity, redact: Redact): RuntimeActivity {
  const payload = record(activity.payload);
  if (!payload) return activity;
  const data = record(payload.data);
  const v2 = record(payload.v2);
  return {
    ...activity,
    payload: {
      ...payload,
      ...(typeof payload.detail === "string" ? { detail: cut(payload.detail, DETAIL_LIMIT, redact) } : {}),
      ...(typeof payload.summary === "string" ? { summary: cut(payload.summary, DETAIL_LIMIT, redact) } : {}),
      ...(data ? {
        data: Object.fromEntries(Object.entries(data).map(([key, value]) =>
          [key, BOUNDED_DATA_KEYS.has(key) ? boundedValue(value, 0, DETAIL_LIMIT, redact) : value])),
      } : {}),
      ...(v2 ? { v2: boundedV2Record(v2, redact) } : {}),
    },
  };
}

/** The thread's latest run: the turn a V1 reader called `latestTurn`. */
export function latestV2Run(projection: V2Projection): V2Run | null {
  return projection.runs.reduce<V2Run | null>((latest, run) =>
    !latest || run.ordinal > latest.ordinal ? run : latest, null);
}

/** The run the runtime started for one of the plane's messages. */
export function v2RunForMessage(projection: V2Projection, messageId: string): V2Run | null {
  return projection.runs.find((run) => run.userMessageId === messageId) ?? null;
}

function turnState(status: string): Turn["state"] {
  if (!v2RunSettled(status)) return "running";
  if (status === "completed") return "completed";
  return status === "failed" ? "error" : "interrupted";
}

/** The reason a run failed: its last error item, else its provider session's. */
export function v2RunFailure(projection: V2Projection, runId: string): string | null {
  const failure = projection.turnItems.findLast((item) => item.type === "error" && item.runId === runId);
  return text(record(failure?.failure)?.message) ?? null;
}

/** The provider session serving the thread now: its active provider thread's, else the newest attached. */
export function activeV2ProviderSession(projection: V2Projection) {
  const active = projection.providerThreads.find((thread) => thread.id === projection.thread.activeProviderThreadId);
  return projection.providerSessions.find((session) => session.id === active?.providerSessionId) ??
    projection.providerSessions.at(-1) ?? null;
}

function sessionView(projection: V2Projection, latest: V2Run | null): RuntimeThreadSnapshot["thread"]["session"] {
  const session = activeV2ProviderSession(projection);
  if (!session) return null;
  const running = latest && !v2RunSettled(latest.status) ? latest.id : null;
  return {
    status: session.status === "waiting" ? "running" : session.status,
    lastError: (latest ? v2RunFailure(projection, latest.id) : null) ?? session.lastError ?? null,
    activeTurnId: running,
    providerSessionId: session.id,
  } as RuntimeThreadSnapshot["thread"]["session"];
}

function messages(projection: V2Projection): RuntimeMessage[] {
  return projection.messages
    .map((message): RuntimeMessage => ({
      id: message.id,
      role: message.role,
      text: message.text,
      turnId: message.runId,
      streaming: message.streaming,
      createdAt: message.createdAt,
    }))
    .toSorted((left, right) => time(left.createdAt) - time(right.createdAt) || (left.id < right.id ? -1 : 1));
}

type Phase = "started" | "updated" | "completed";

function phaseOf(status: string): Phase {
  if (status === "pending" || status === "idle") return "started";
  if (status === "running" || status === "waiting") return "updated";
  return "completed";
}

/** A value as detail text: a string as it is, anything else as JSON, blank as absent. */
function detailText(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value : value === undefined || value === null ? undefined : JSON.stringify(value);
  return raw?.trim() || undefined;
}

/** `server.tool` (Codex MCP) and `mcp__server__tool` (Claude) name a server; anything else is a bare tool. */
export function v2ToolIdentity(toolName: string | undefined): { server: string | null; tool: string | null } {
  if (!toolName) return { server: null, tool: null };
  const claude = /^mcp__(.+?)__(.+)$/u.exec(toolName);
  if (claude) return { server: claude[1]!, tool: claude[2]! };
  const dot = toolName.indexOf(".");
  if (dot > 0 && dot < toolName.length - 1) return { server: toolName.slice(0, dot), tool: toolName.slice(dot + 1) };
  return { server: null, tool: toolName };
}

const FAILED_ITEM_STATUSES = new Set(["failed"]);

/** What the item did, for its row: the runtime's own title, else a plain name for its type. */
function summaryOf(item: V2TurnItem, payload: Rec): string {
  const title = text(item.title) ?? text(payload.title);
  if (title) return title;
  switch (item.type) {
    case "command_execution": return "Command run";
    case "file_change": return text(item.fileName) ? `Changed ${text(item.fileName)}` : "File change";
    case "web_search": return "Web search";
    case "file_search": return "File search";
    case "subagent": return "Subagent";
    case "todo_list": return "Plan updated";
    case "compaction": return "Context compacted";
    case "approval_request": return "Approval requested";
    case "user_input_request": return "Question asked";
    default: return text(payload.toolName) ?? text(item.toolName) ?? "Tool";
  }
}

function activity(item: V2TurnItem, kind: string, phase: string, payload: Rec, tone: RuntimeActivity["tone"]): RuntimeActivity {
  return {
    id: `${item.id}:${phase}`,
    tone,
    kind,
    summary: summaryOf(item, payload),
    payload: { ...payload, v2: item },
    turnId: item.runId,
  };
}

function toolActivity(item: V2TurnItem): RuntimeActivity | null {
  const phase = phaseOf(item.status);
  const failed = FAILED_ITEM_STATUSES.has(item.status) || item.outputIndicatesFailure === true ||
    (typeof item.exitCode === "number" && item.exitCode !== 0);
  const base = { toolCallId: item.id, title: item.title, status: failed ? "failed" : item.status };
  const tone: RuntimeActivity["tone"] = failed ? "error" : "tool";
  switch (item.type) {
    case "command_execution":
      return activity(item, `tool.${phase}`, phase, {
        ...base, itemType: "command_execution",
        data: {
          input: { command: detailText(item.input) },
          item: { id: item.id, command: detailText(item.input), ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}) },
        },
      }, tone);
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes.map(record).filter((change) => change !== null) : [];
      const files = changes.length > 0
        ? changes.map((change) => ({ path: change.path, kind: change.operation }))
        : text(item.fileName) ? [{ path: item.fileName }] : [];
      return activity(item, `tool.${phase}`, phase, {
        ...base, itemType: "file_change",
        data: { files, ...(typeof item.additions === "number" ? { additions: item.additions } : {}),
          ...(typeof item.deletions === "number" ? { deletions: item.deletions } : {}) },
      }, tone);
    }
    case "web_search":
      return activity(item, `tool.${phase}`, phase, {
        ...base, itemType: "web_search", toolName: "web_search",
        data: { arguments: { query: Array.isArray(item.patterns) ? detailText(item.patterns.join(" ")) : undefined } },
        detail: detailText(item.results),
      }, tone);
    case "file_search":
      return activity(item, `tool.${phase}`, phase, {
        ...base, itemType: "dynamic_tool_call", toolName: "file_search",
        data: { arguments: { pattern: detailText(item.pattern) } },
        detail: detailText(item.results),
      }, tone);
    case "dynamic_tool": {
      const identity = v2ToolIdentity(text(item.toolName));
      return activity(item, `tool.${phase}`, phase, {
        ...base,
        itemType: identity.server ? "mcp_tool_call" : "dynamic_tool_call",
        ...(identity.tool ? { toolName: identity.tool } : {}),
        ...(identity.server ? { server: identity.server } : {}),
        data: { arguments: item.input },
        detail: detailText(item.output),
      }, tone);
    }
    default:
      return null;
  }
}

const PLAN_STATUS: Readonly<Record<string, string>> = { running: "inProgress", pending: "pending", completed: "completed" };

/** Subagent status in the words the execution graph reads (running, waiting, completed, failed, cancelled). */
const SUBAGENT_STATUS: Readonly<Record<string, string>> = {
  pending: "running", idle: "waiting", running: "running", waiting: "waiting",
  completed: "completed", failed: "failed", cancelled: "cancelled", interrupted: "cancelled",
};

/**
 * The child id a subagent is known by everywhere: its record, which it has from
 * its first revision. Its own runtime thread comes later, and an id that changed
 * between revisions would change the subagent's place in the execution graph.
 */
export function v2SubagentChildId(item: V2TurnItem): string {
  return text(item.subagentId) ?? item.id;
}

/** A subagent's start (which opens its execution) and its current phase, owned by its child thread. */
function subagentActivities(item: V2TurnItem, projection: V2Projection): RuntimeActivity[] {
  const phase = phaseOf(item.status);
  const subagent = projection.subagents.find((entry) => entry.id === item.subagentId);
  const taskId = v2SubagentChildId(item);
  const payload = {
    taskId,
    agentKind: "agent",
    childSessionId: taskId,
    title: text(subagent?.title) ?? item.title,
    ...(text(subagent?.model) ? { model: subagent!.model } : {}),
    status: SUBAGENT_STATUS[item.status] ?? item.status,
    detail: detailText(item.prompt),
    ...(detailText(item.result ?? item.progress) ? { summary: detailText(item.result ?? item.progress) } : {}),
  };
  const tone = item.status === "failed" ? "error" : "info";
  const started = activity(item, "task.started", "started", { ...payload, status: "running" }, "info");
  if (phase === "started") return [started];
  return [started, activity(item, phase === "updated" ? "task.progress" : "task.completed", phase, payload, tone)];
}

function requestActivities(item: V2TurnItem, projection: V2Projection): RuntimeActivity[] {
  const request = projection.runtimeRequests.find((entry) => entry.id === item.requestId);
  const resolved = request ? request.status !== "pending" : v2RunSettled(item.status) || item.status === "completed";
  const question = item.type === "user_input_request";
  const requested = activity(item, question ? "user-input.requested" : "approval.requested", "requested", question
    ? { requestId: item.requestId, questions: item.questions }
    : { requestId: item.requestId, requestKind: item.requestKind, ...(detailText(item.prompt) ? { detail: detailText(item.prompt) } : {}) },
  "approval");
  if (!resolved) return [requested];
  return [requested, activity(item, question ? "user-input.resolved" : "approval.resolved", "resolved", {
    requestId: item.requestId,
    ...(request?.decision !== undefined ? { decision: request.decision } : {}),
    ...(request?.answers !== undefined ? { answers: request.answers } : {}),
  }, "info")];
}

function itemActivities(item: V2TurnItem, projection: V2Projection): RuntimeActivity[] {
  if (item.type === "subagent") return subagentActivities(item, projection);
  if (item.type === "approval_request" || item.type === "user_input_request") return requestActivities(item, projection);
  if (item.type === "todo_list") {
    const steps = Array.isArray(item.steps) ? item.steps.map(record).filter((step) => step !== null) : [];
    return [activity(item, "turn.plan.updated", "plan", {
      plan: steps.map((step) => ({ step: step.text, status: PLAN_STATUS[String(step.status)] ?? step.status })),
      ...(text(item.explanation) ? { explanation: item.explanation } : {}),
    }, "info")];
  }
  if (item.type === "compaction") {
    const run = projection.runs.find((entry) => entry.id === item.runId);
    return [activity(item, "context-compaction", "compaction", {
      state: item.status === "completed" ? "compacted" : item.status,
      ...(run ? { requestId: run.userMessageId } : {}),
    }, "info")];
  }
  if (item.type === "error") {
    // One error item per provider turn: while the provider retries it is
    // running with the attempt, then it fails for good. A retry is a warning
    // the no-progress watchdog counts; the final failure is the turn's error.
    const failure = record(item.failure);
    const reason = { message: failure?.message, class: failure?.class, code: failure?.code, retryable: failure?.retryable };
    const retry = record(item.retry);
    if (!v2RunSettled(item.status)) {
      return [activity(item, "runtime.warning", "warning", { ...reason, ...(retry ? { detail: { attempt: retry.attempt } } : {}) }, "info")];
    }
    return [activity(item, "runtime.error", "error", reason, "error")];
  }
  const tool = toolActivity(item);
  return tool ? [tool] : [];
}

const CHILD_ITEM_TYPES = new Set(["command_execution", "file_change", "file_search", "web_search", "dynamic_tool", "todo_list"]);

/**
 * What a subagent's own thread contributes to its parent's record: its tool
 * calls and its messages, owned by the child (`timelineBypass` keeps them off
 * the parent's step timeline; the canonical lane and the child's card read
 * them by their child session). Approvals and questions a subagent raises
 * arrive on the parent thread, so they are not read here.
 */
export function runtimeChildThreadActivities(snapshot: V2ThreadSnapshot, parentThreadId: string, childId: string): RuntimeActivity[] {
  const owner = { timelineBypass: true, childSessionId: childId, agentId: childId, parentAgentId: parentThreadId };
  const items = snapshot.projection.turnItems
    .filter((item) => CHILD_ITEM_TYPES.has(item.type))
    .toSorted((left, right) => (Number(left.ordinal) || 0) - (Number(right.ordinal) || 0) || (left.id < right.id ? -1 : 1))
    .flatMap((item) => itemActivities(item, snapshot.projection))
    .map((entry) => ({ ...entry, payload: { ...(record(entry.payload) ?? {}), ...owner } }));
  const messages = snapshot.projection.messages
    .filter((message) => message.role === "assistant" && message.text.trim())
    .toSorted((left, right) => time(left.createdAt) - time(right.createdAt))
    .map((message): RuntimeActivity => ({
      id: `${message.id}:child-message`,
      tone: "info",
      kind: message.streaming ? "child.message.updated" : "child.message.completed",
      summary: "Subagent message",
      payload: {
        ...owner,
        messageId: message.id,
        text: message.text,
        status: message.streaming ? "running" : "completed",
        streamKind: "assistant_text",
        v2: message,
      },
      turnId: message.runId,
    }));
  return [...items, ...messages];
}

/** The context in use per provider thread, stored as the usage frame the composer ring reads. */
function contextActivities(projection: V2Projection): RuntimeActivity[] {
  return projection.providerThreads.flatMap((thread) => {
    const usage = record(thread.contextUsage);
    if (!usage || typeof usage.usedTokens !== "number" || usage.usedTokens <= 0) return [];
    const run = projection.runs.filter((entry) => entry.providerThreadId === thread.id)
      .reduce<V2Run | null>((latest, entry) => !latest || entry.ordinal > latest.ordinal ? entry : latest, null);
    return [{
      id: `context:${thread.id}`,
      tone: "info" as const,
      kind: "context-window.updated",
      summary: "Context window",
      payload: { ...usage, v2: thread },
      turnId: run?.id ?? null,
    }];
  });
}

export function runtimeThreadView(snapshot: V2ThreadSnapshot): RuntimeThreadSnapshot {
  const { projection } = snapshot;
  const latest = latestV2Run(projection);
  const assistant = latest
    ? projection.messages.filter((message) => message.role === "assistant" && message.runId === latest.id)
      .toSorted((left, right) => time(left.createdAt) - time(right.createdAt)).at(-1) ?? null
    : null;
  const items = projection.turnItems.toSorted((left, right) =>
    (Number(left.ordinal) || 0) - (Number(right.ordinal) || 0) || time(left.updatedAt) - time(right.updatedAt) ||
    (left.id < right.id ? -1 : 1));
  return {
    snapshotSequence: snapshot.snapshotSequence,
    thread: {
      id: projection.thread.id,
      ...(typeof projection.thread.runtimeMode === "string"
        ? { runtimeMode: projection.thread.runtimeMode as RuntimeThreadSnapshot["thread"]["runtimeMode"] }
        : {}),
      latestTurn: latest
        ? {
            turnId: latest.id,
            state: turnState(latest.status),
            requestedAt: latest.requestedAt,
            startedAt: latest.startedAt,
            completedAt: latest.completedAt,
            assistantMessageId: assistant?.id ?? null,
            userMessageId: latest.userMessageId,
            error: v2RunFailure(projection, latest.id),
          }
        : null,
      messages: messages(projection),
      activities: [...items.flatMap((item) => itemActivities(item, projection)), ...contextActivities(projection)],
      session: sessionView(projection, latest),
    },
  };
}
