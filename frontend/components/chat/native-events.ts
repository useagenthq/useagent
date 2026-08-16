// Native event lane (frontend) — the versioned durable projection of the backend
// lossless capture, streamed as `event: native` frames on GET /api/runs/:id/events
// (see backend src/runs/native-events.ts). One job: type the wire frame, parse it
// defensively (schema-version aware), and derive per-child fidelity from it.
//
// A frame's `eventId` is the stable dedupe key (one per native part / lifecycle
// row); `seq` is the monotonic per-run cursor. A part revision re-emits the SAME
// eventId with a HIGHER seq — consumers keep the largest seq (native-store.ts).

import { type ChildUsage, mergeChildUsage, normalizeChildUsage } from "./child-usage";
import { asRecord } from "./types";

export type { ChildUsage } from "./child-usage";

/** Wire schema version this client understands. Bumped on the backend when the
 *  {@link NativeFrame} shape changes; older frames upcast, newer parse best-effort
 *  (the envelope is additive). */
export const NATIVE_SCHEMA_VERSION = 1;

export interface NativeFrameIds {
  readonly sessionId: string | null;
  readonly parentSessionId: string | null;
  readonly messageId: string | null;
  readonly partId: string | null;
  readonly callId: string | null;
}

/** A versioned native-event frame (mirrors the backend envelope). `payload` is
 *  bounded and may be an `{ _unparseable, _bytes }` marker for over-cap capture,
 *  so consumers must treat it as unknown. */
export interface NativeFrame {
  readonly schemaVersion: number;
  readonly eventId: string;
  readonly seq: number;
  readonly provider: string;
  readonly eventType: string;
  readonly native: NativeFrameIds;
  readonly payload: unknown;
}

const readString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Parse an SSE `native` frame payload into a {@link NativeFrame}, or null if it is
 * malformed. Schema-version handling: a missing/invalid `schemaVersion` is treated
 * as v1; a newer version is accepted best-effort (fields are additive) so a forward
 * deploy never blanks the rail. `eventId`/`seq`/`eventType` are required.
 */
export function parseNativeFrame(raw: unknown): NativeFrame | null {
  const o = asRecord(raw);
  if (!o) return null;
  const eventId = readString(o.eventId);
  const eventType = readString(o.eventType);
  const seq = typeof o.seq === "number" ? o.seq : null;
  if (eventId === null || eventType === null || seq === null) return null;

  const native = asRecord(o.native);
  const schemaVersion =
    typeof o.schemaVersion === "number" ? o.schemaVersion : NATIVE_SCHEMA_VERSION;
  return {
    schemaVersion,
    eventId,
    seq,
    provider: readString(o.provider) ?? "opencode",
    eventType,
    native: {
      sessionId: native ? readString(native.sessionId) : null,
      parentSessionId: native ? readString(native.parentSessionId) : null,
      messageId: native ? readString(native.messageId) : null,
      partId: native ? readString(native.partId) : null,
      callId: native ? readString(native.callId) : null,
    },
    payload: o.payload,
  };
}

// ── Child fidelity ──────────────────────────────────────────────────────────

/** Authoritative child-session status, from native state (not parent liveness). */
export type ChildStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface ChildActivityEntry {
  readonly at: string;
  readonly summary: string;
}

export interface ChildFidelity {
  /** The parent's `task`-tool call id — the stable link to the subagent card. */
  readonly callId: string;
  /** The child session the task launched, once discoverable. */
  readonly childSessionId: string | null;
  readonly status: ChildStatus;
  /** The child's returned answer (task result / last assistant text), if any. */
  readonly resultText: string | null;
  /** Latest bounded native progress, independent of terminal result text. */
  readonly progress: string | null;
  readonly lastToolName: string | null;
  readonly recentActivity: readonly ChildActivityEntry[];
  /** Provider-cumulative usage. Duplicate/late frames max-merge idempotently. */
  readonly usage: ChildUsage | null;
}

const TASK_CHILD_ID = /<task\s+id="([^"]+)"/;
const TASK_RESULT = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/;

/** running/completed/failed from a `part.tool.<status>` event type. */
function statusFromEventType(eventType: string): ChildStatus {
  if (eventType.endsWith(".error")) return "failed";
  if (eventType.endsWith(".completed")) return "completed";
  return "running";
}

const T3_CHILD_STATUSES = new Set<ChildStatus>([
  "pending",
  "running",
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function t3TaskStatus(
  eventType: string,
  payload: Record<string, unknown>,
  prior?: ChildStatus,
): ChildStatus {
  const activityPayload = asRecord(payload.payload);
  const explicit = activityPayload ? readString(activityPayload.status) : null;
  if (explicit && T3_CHILD_STATUSES.has(explicit as ChildStatus)) {
    return explicit as ChildStatus;
  }
  if (explicit === "stopped") return "interrupted";
  if (eventType.endsWith("task.completed") || explicit === "completed") return "completed";
  if (eventType.endsWith("task.started")) return "running";
  return prior ?? "running";
}

function appendActivity(
  entries: readonly ChildActivityEntry[],
  entry: ChildActivityEntry,
): readonly ChildActivityEntry[] {
  if (entries.at(-1)?.summary === entry.summary) return entries;
  return [...entries, entry].slice(-8);
}

/**
 * Derive each subagent's authoritative status + result text from native frames,
 * keyed by the parent's `task`-tool call id (the stable link to its card).
 *
 * Status comes from the task tool's own native state — `part.tool.completed` →
 * completed, `part.tool.error` → failed, anything earlier → running — so a failed
 * child reads failed even while its siblings complete, independent of whether the
 * parent run is still live. Result text prefers the task tool's `<task_result>`
 * and falls back to the child session's latest assistant text. Frames of unknown
 * type are simply ignored (rendered safely as nothing here).
 */
export function deriveChildFidelity(
  frames: readonly NativeFrame[],
): ReadonlyMap<string, ChildFidelity> {
  const byCall = new Map<string, ChildFidelity>();
  const lastTextBySession = new Map<string, string>();

  // Process in seq order so a later revision wins (the store already keeps only
  // the latest per eventId; sorting defends against unordered input).
  const ordered = [...frames].sort((a, b) => a.seq - b.seq);
  for (const frame of ordered) {
    const payload = asRecord(frame.payload);

    if (frame.provider === "t3" && frame.eventType === "t3.activity.tool.progress") {
      const activityPayload = payload ? asRecord(payload.payload) : null;
      const taskId = activityPayload ? readString(activityPayload.taskId) : null;
      const prior = taskId ? byCall.get(taskId) : undefined;
      const lastToolName = activityPayload ? readString(activityPayload.toolName) : null;
      if (!taskId || !prior || !lastToolName) continue;
      byCall.set(taskId, {
        ...prior,
        progress: `Running ${lastToolName}`,
        lastToolName,
        recentActivity: appendActivity(prior.recentActivity, {
          at: readString(payload?.createdAt) ?? "",
          summary: `Running ${lastToolName}`,
        }),
      });
      continue;
    }

    if (frame.provider === "t3" && frame.eventType.startsWith("t3.activity.task.")) {
      const activityPayload = payload ? asRecord(payload.payload) : null;
      const taskId =
        frame.native.callId ?? (activityPayload ? readString(activityPayload.taskId) : null);
      if (!taskId || !payload || !activityPayload || activityPayload.agentKind !== "agent") {
        continue;
      }
      const prior = byCall.get(taskId);
      const summary = readString(activityPayload.summary) ?? readString(activityPayload.detail);
      const error = readString(activityPayload.error);
      const lastToolName = readString(activityPayload.lastToolName);
      const status = t3TaskStatus(frame.eventType, payload, prior?.status);
      const isCompletion = frame.eventType.endsWith("task.completed");
      const progress = summary ?? (lastToolName ? `Running ${lastToolName}` : prior?.progress ?? null);
      const recentActivity = summary || lastToolName
          ? appendActivity(prior?.recentActivity ?? [], {
            at: readString(payload.createdAt) ?? "",
            summary: summary ?? `Running ${lastToolName}`,
          })
        : prior?.recentActivity ?? [];
      byCall.set(taskId, {
        callId: taskId,
        childSessionId: taskId,
        status,
        resultText: error ?? (isCompletion ? summary : null) ?? prior?.resultText ?? null,
        progress,
        lastToolName: lastToolName ?? prior?.lastToolName ?? null,
        recentActivity,
        usage: mergeChildUsage(
          prior?.usage ?? null,
          normalizeChildUsage(activityPayload.typedUsage),
        ),
      });
      continue;
    }

    if (frame.eventType.startsWith("part.text")) {
      const sid = frame.native.sessionId;
      const text = payload ? readString(payload.text) : null;
      if (sid && text) lastTextBySession.set(sid, text);
      continue;
    }

    const isTaskTool = payload?.type === "tool" && payload.tool === "task";
    if (isTaskTool && frame.native.callId) {
      const state = asRecord(payload.state);
      const output = state ? (readString(state.output) ?? "") : "";
      const prior = byCall.get(frame.native.callId);
      byCall.set(frame.native.callId, {
        callId: frame.native.callId,
        childSessionId: TASK_CHILD_ID.exec(output)?.[1] ?? prior?.childSessionId ?? null,
        status: statusFromEventType(frame.eventType),
        resultText: TASK_RESULT.exec(output)?.[1]?.trim() || prior?.resultText || null,
        progress: prior?.progress ?? null,
        lastToolName: prior?.lastToolName ?? null,
        recentActivity: prior?.recentActivity ?? [],
        usage: prior?.usage ?? null,
      });
    }
  }

  // Fill result text from the child's own last assistant text when the tool
  // output didn't carry a <task_result> (e.g. a still-streaming child).
  const out = new Map<string, ChildFidelity>();
  for (const [callId, fidelity] of byCall) {
    const resultText =
      fidelity.resultText ??
      (fidelity.childSessionId ? (lastTextBySession.get(fidelity.childSessionId) ?? null) : null);
    out.set(callId, { ...fidelity, resultText });
  }
  return out;
}
