// Framework-free thread SSE frame vocabulary + decoder. This is the wire contract
// the useAgent backend publishes on the thread-scoped SSE (`/api/runs/:root/thread-events`)
// and the pure decoder that turns a raw `(event, data)` frame into a typed union - with
// NO React, product store, or product parser dependency. The useAgent React hook keeps its
// own native-lane projection; the client library owns only the transport decode + the
// canonical lane (the provider-neutral render source).

import type { CanonicalAgentEvent } from "@useagent/agent-harness/canonical";

/** The `event:` names on the thread SSE. Kept in sync with the backend publisher. */
export const THREAD_FRAME_TYPES = [
  "snapshot",
  "run",
  "step",
  "delta",
  "native",
  "canonical",
  "canonical-complete",
  "done",
] as const;
export type ThreadFrameType = (typeof THREAD_FRAME_TYPES)[number];

/** A canonical event as delivered on the SSE: the provider-neutral event PLUS the two
 *  useAgent delivery fields the reducer needs - `deliverySeq` (a bigserial >= 1 that
 *  totally orders the run's canonical lane) and `revision` (>= 0; a higher revision of
 *  the same `eventId` supersedes). These are useAgent delivery metadata, not part of the
 *  provider-neutral vocabulary, so they live here rather than in @useagent/agent-harness. */
export type CanonicalThreadEvent = CanonicalAgentEvent & {
  readonly deliverySeq: number;
  readonly revision: number;
};

/** The completion record: a run's canonical projection is durable + trustworthy. */
export interface CanonicalCompleteFrame {
  readonly runId: string;
}

/** A decoded thread frame. `native`/`run`/`step`/`delta`/`snapshot` carry raw product
 *  payloads the useAgent hook still projects natively; the client library validates +
 *  owns only the canonical lane. `unknown` is a forward-compatible catch-all: an
 *  unrecognized future frame is surfaced, never coerced into a known kind or fatal. */
export type DecodedFrame =
  | { kind: "canonical"; event: CanonicalThreadEvent }
  | { kind: "canonical-complete"; complete: CanonicalCompleteFrame }
  | { kind: "raw"; type: Exclude<ThreadFrameType, "canonical" | "canonical-complete">; payload: Record<string, unknown> }
  | { kind: "unknown"; type: string; payload: Record<string, unknown> }
  | { kind: "malformed"; type: string };

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
function isNonEmptyString(s: unknown): s is string {
  return typeof s === "string" && s.length > 0;
}

/** Validate the canonical delivery envelope BEFORE it reaches the reducer: a missing
 *  eventId/deliverySeq/revision/kind would corrupt ordering (NaN sort) or dedupe. The
 *  optional `frameThreadId` (from the SSE frame) must match the event's thread. Returns
 *  the typed event or null (dropped, never misapplied). */
export function validateCanonicalThreadEvent(
  raw: unknown,
  frameThreadId?: unknown,
): CanonicalThreadEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.schemaVersion !== 1) return null;
  if (!isNonEmptyString(e.eventId)) return null;
  if (!isNonEmptyString(e.kind)) return null;
  if (!isNonEmptyString(e.runId) || !isNonEmptyString(e.threadId)) return null;
  if (!isFiniteNumber(e.seq)) return null;
  if (!isFiniteNumber(e.deliverySeq) || e.deliverySeq <= 0) return null; // bigserial >= 1
  if (!isFiniteNumber(e.revision) || e.revision < 0) return null;
  // The stream is thread-scoped server-side; a frame whose event names a different thread
  // than its envelope is malformed. Enforced only when the frame carries a non-empty
  // threadId (matches the product validator exactly, so decoding is behavior-identical).
  if (isNonEmptyString(frameThreadId) && frameThreadId !== e.threadId) return null;
  // identity, when present, must be an object (the reducer reads identity.native*).
  if (e.identity !== undefined && (typeof e.identity !== "object" || e.identity === null)) return null;
  return raw as CanonicalThreadEvent;
}

/** Validate a `canonical-complete` frame's `complete` record. Matches the product
 *  validator exactly: a non-empty runId, and if BOTH the frame threadId and the record's
 *  own threadId are present they must agree (never trust a cross-thread completion).
 *  Returns the typed record or null (dropped). */
export function validateCanonicalComplete(
  raw: unknown,
  frameThreadId?: unknown,
): CanonicalCompleteFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (!isNonEmptyString(c.runId)) return null;
  if (isNonEmptyString(frameThreadId) && isNonEmptyString(c.threadId) && c.threadId !== frameThreadId) return null;
  return { runId: c.runId };
}

/** Decode ONE raw SSE frame `(event, data)` into a typed {@link DecodedFrame}. Pure:
 *  no store, no product parser, no React. Malformed JSON, a non-object payload, or an
 *  invalid canonical envelope yields a `malformed`/dropped frame rather than throwing -
 *  a bad frame never tears down the connection. Unknown future `event:` names surface as
 *  `unknown`. */
export function decodeFrame(event: string, data: string): DecodedFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { kind: "malformed", type: event };
  }
  // A well-formed thread frame is ALWAYS a JSON object. A non-object (null, number,
  // string, boolean, or array) is malformed and must never be dereferenced.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed", type: event };
  }
  const obj = parsed as Record<string, unknown>;
  if (event === "canonical") {
    const ev = validateCanonicalThreadEvent(obj.event, obj.threadId);
    return ev ? { kind: "canonical", event: ev } : { kind: "malformed", type: event };
  }
  if (event === "canonical-complete") {
    const complete = validateCanonicalComplete(obj.complete, obj.threadId);
    return complete ? { kind: "canonical-complete", complete } : { kind: "malformed", type: event };
  }
  if ((THREAD_FRAME_TYPES as readonly string[]).includes(event)) {
    return { kind: "raw", type: event as Exclude<ThreadFrameType, "canonical" | "canonical-complete">, payload: obj };
  }
  return { kind: "unknown", type: event, payload: obj };
}
