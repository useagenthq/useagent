// Phase 1: the canonical -> timeline reducer (frontend view policy).
//
// The backend translator is LOSSLESS + emits in source order; the DISPLAY POLICY +
// timeline ORDERING live here (delivery order != view order). This reduces a canonical
// event stream into the same TimelineNode[] the legacy buildTimeline produces -
// markers, assistant-text bursts, and tool rows in true message-anchored order - so
// React can consume canonical instead of the two native lanes. Slice 2 proves
// byte-for-byte equivalence on the protected fixture + synthetic text/marker/child
// fixtures; the React cutover (behind a legacy fallback) only lands after that gate.
//
// Ordering mirrors buildTimeline exactly:
//   markers    k0 = -2,               k1 = 0, k2 = nativeSeq
//   text       k0 = msgOrderKey(mid), k1 = 0, k2 = nativeSeq   (step-messages only)
//   tool rows  k0 = msgOrderKey(mid), k1 = 1, k2 = step.idx
// msgOrderKey(mid) = the message.started (step-start) anchor seq; partId->messageId
// comes from the parts' native ids. Tool detail is still read from the durable step
// sidecar keyed by identity.nativeEventId (the "bounded raw sidecar").

import { deriveTrace, type ApiStep } from "./types";
import { isNarration, parseMarker, type TimelineNode, type TimelineMarker } from "./timeline";

/** Structural view of a canonical event (envelope base + flattened body fields). */
export interface CanonicalEventLike {
  readonly kind: string;
  readonly seq: number;
  readonly identity?: {
    readonly nativeEventId?: string;
    readonly nativeSessionId?: string;
    readonly nativeSeq?: number;
    readonly nativeMessageId?: string;
    readonly nativePartId?: string;
  };
  readonly messageId?: string;
  readonly text?: string;
  readonly childId?: string;
  readonly markerType?: string;
  readonly title?: string;
  readonly detail?: string;
  /** The originating skynet-lane frame, carried by the translator so the marker is
   *  reconstructed with the SAME parser the legacy native lane uses (H3, lossless). */
  readonly sourceEventType?: string;
  readonly sourcePayload?: Record<string, unknown>;
  /** `commands.updated` body: the provider's native slash-command catalog for the session.
   *  `commands` is the bare name list; `catalog` carries name + description + input hint. */
  readonly commands?: readonly string[];
  readonly catalog?: readonly {
    readonly name: string;
    readonly description?: string | null;
    readonly input?: string | null;
  }[];
}

/** A canonical event as stored/streamed to the client: the reducer's structural view
 *  plus the identity needed to accumulate + dedupe (runId + eventId + immutable
 *  deliverySeq + revision). This is the SSE `canonical` frame's `event`. */
export interface StoredCanonicalEvent extends CanonicalEventLike {
  readonly schemaVersion: number;
  readonly eventId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly deliverySeq: number;
  readonly revision: number;
}

/** The canonical envelope version this client understands. MUST match the backend
 *  CANONICAL_SCHEMA_VERSION; a frame carrying any other version is dropped (forward-
 *  compat) rather than misapplied. */
export const CANONICAL_SCHEMA_VERSION = 1;

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validate a canonical SSE frame's `event` STRUCTURALLY before it touches the store (H4,
 *  review issue #6). The old check accepted anything with a runId + eventId, so a frame
 *  missing seq/deliverySeq/revision/kind would corrupt ordering (NaN sort) or dedupe.
 *  Every envelope field is checked; `frameThreadId` (the frame's own threadId) must match
 *  the event's threadId. Returns the typed event, or null to drop it. */
export function validateCanonicalEvent(raw: unknown, frameThreadId: unknown): StoredCanonicalEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (e.schemaVersion !== CANONICAL_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(e.kind)) return null;
  if (!isNonEmptyString(e.eventId)) return null;
  if (!isNonEmptyString(e.runId)) return null;
  if (!isNonEmptyString(e.threadId)) return null;
  if (!isFiniteNumber(e.seq)) return null;
  if (!isFiniteNumber(e.deliverySeq) || e.deliverySeq <= 0) return null; // bigserial, always >= 1
  if (!isFiniteNumber(e.revision) || e.revision < 0) return null;
  // The stream is thread-scoped server-side; a frame whose event names a different thread
  // than its envelope is malformed - never apply it cross-thread.
  if (isNonEmptyString(frameThreadId) && e.threadId !== frameThreadId) return null;
  // identity, when present, must be an object (the reducer reads identity.native*).
  if (e.identity !== undefined && (typeof e.identity !== "object" || e.identity === null)) return null;
  return e as unknown as StoredCanonicalEvent;
}

/** The render-path gate (H2+H4): use the canonical timeline for a turn ONLY when the flag
 *  is on AND the run's canonicalization reached its durable completion record AND there
 *  are canonical rows. A still-provisional (incomplete) or empty lane falls back to legacy,
 *  so a partial/retrying snapshot never renders. Pure, so both flag states are testable. */
export function shouldUseCanonicalTimeline(
  flagOn: boolean,
  turn: { readonly canonical?: readonly CanonicalEventLike[]; readonly canonicalComplete?: boolean },
): boolean {
  return flagOn && turn.canonicalComplete === true && !!turn.canonical && turn.canonical.length > 0;
}

/** Validate a canonical-complete frame's `complete` payload (H4). */
export function validateCanonicalComplete(raw: unknown, frameThreadId: unknown): { runId: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (!isNonEmptyString(c.runId)) return null;
  if (isNonEmptyString(frameThreadId) && isNonEmptyString(c.threadId) && c.threadId !== frameThreadId) return null;
  return { runId: c.runId };
}

/** Canonical context.marker -> TimelineMarker, LOSSLESS (H3): the translator carries the
 *  originating skynet frame (sourceEventType + sourcePayload), so we reconstruct with the
 *  SAME parseMarker the legacy native lane uses - the marker node is deep-equal, never
 *  fabricated. The coarse markerType/title fallback covers only an event that predates the
 *  source fields (defensive; the opencode translator always carries them). */
function toTimelineMarker(e: CanonicalEventLike): TimelineMarker {
  if (e.sourceEventType) {
    const parsed = parseMarker(e.sourceEventType, e.sourcePayload ?? {});
    if (parsed) return parsed;
  }
  const t = e.markerType;
  if (t === "skill" || t === "playbook") {
    return { kind: "skill", playbook: t === "playbook", name: e.title ?? "skill", version: 0, hash: "" };
  }
  if (t === "memory") {
    return { kind: "memory", op: "remember", scope: "org", failed: false, reconciled: false };
  }
  return { kind: "context", source: t ?? "context", itemCount: 0, query: null };
}

type Ranked = { node: TimelineNode; k0: number; k1: number; k2: number };
const MAX = Number.MAX_SAFE_INTEGER;

export function buildTimelineFromCanonical(
  events: readonly CanonicalEventLike[],
  stepsById: ReadonlyMap<string, ApiStep>,
  live = false,
): TimelineNode[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  // Pass 1: derive the same ordering inputs buildTimeline builds from frames.
  const childSessions = new Set<string>();
  const msgOrderKey = new Map<string, number>(); // messageId -> anchor (step-start) seq
  const partMessage = new Map<string, string>(); // partId -> messageId
  const stepMessages = new Set<string>();        // messages that began (step-start)
  for (const e of ordered) {
    if (e.kind === "child.started" && e.childId) childSessions.add(e.childId);
    const ns = e.identity?.nativeSeq;
    const mid = e.identity?.nativeMessageId;
    const pid = e.identity?.nativePartId;
    if (mid && pid) partMessage.set(pid, mid);
    if (e.kind === "message.started" && e.messageId) {
      stepMessages.add(e.messageId);
      if (typeof ns === "number") {
        const prev = msgOrderKey.get(e.messageId);
        if (prev === undefined || ns < prev) msgOrderKey.set(e.messageId, ns);
      }
    }
  }

  const ranked: Ranked[] = [];
  const seenTextPart = new Set<string>();

  for (const e of ordered) {
    // ── context markers (skynet lane): lead the turn ──────────────────────────
    if (e.kind === "context.marker") {
      ranked.push({
        node: { kind: "marker", key: e.identity?.nativeEventId ?? String(e.seq), marker: toTimelineMarker(e) },
        k0: -2, k1: 0, k2: e.identity?.nativeSeq ?? e.seq,
      });
      continue;
    }
    // ── assistant text bursts (root, step-messages only; child text -> its pane) ─
    if (e.kind === "message.delta") {
      const sid = e.identity?.nativeSessionId;
      const mid = e.messageId;
      if (sid && childSessions.has(sid)) continue; // subagent chatter
      if (!mid || !stepMessages.has(mid)) continue; // injected context / user prompt
      if (!e.text || !e.text.trim()) continue;
      const key = e.identity?.nativePartId ?? e.identity?.nativeEventId ?? String(e.seq);
      if (seenTextPart.has(key)) continue; // one burst per part (latest wins by seq order)
      seenTextPart.add(key);
      ranked.push({
        node: { kind: "text", key, text: e.text },
        k0: msgOrderKey.get(mid) ?? e.identity?.nativeSeq ?? e.seq, k1: 0, k2: e.identity?.nativeSeq ?? e.seq,
      });
      continue;
    }
    // ── tool rows: step-sourced tool.completed, filtered like buildTimeline ────
    if (e.kind === "tool.completed") {
      const id = e.identity?.nativeEventId;
      const step = id ? stepsById.get(id) : undefined;
      if (!step) continue; // frame-sourced structural tool signal, not a durable row
      if (step.kind === "done") continue;
      if (isNarration(step)) continue;
      const boot = deriveTrace(step).accent === "boot";
      if (boot && !live) continue;
      const ids = nativeOfStep(step);
      const mid = (ids.partID && partMessage.get(ids.partID)) || ids.messageID || null;
      ranked.push({
        node: { kind: "tool", key: step.id, step },
        k0: boot ? -1 : mid ? msgOrderKey.get(mid) ?? MAX : MAX,
        k1: 1, k2: step.idx,
      });
    }
  }

  ranked.sort((a, b) => a.k0 - b.k0 || a.k1 - b.k1 || a.k2 - b.k2);
  return ranked.map((r) => r.node);
}

/** A native slash command as surfaced to the composer's "/" popover. */
export interface CanonicalCommandView {
  readonly name: string;
  readonly description?: string | null;
  readonly input?: string | null;
}

/** The thread's native slash-command catalog read from the DURABLE canonical stream: the
 *  LATEST `commands.updated` across all of the thread's runs, by `deliverySeq` (the per-thread
 *  monotonic order). Because it comes from the durable stream, a reconnect/replay reconstructs
 *  the SAME catalog. An empty replacement legitimately yields []; a thread that NEVER advertised
 *  commands yields null, so the caller can fall back to the live catalog fetch. Pure + total. */
export function selectThreadCommands(
  runs: readonly { readonly canonical: readonly StoredCanonicalEvent[] }[],
): CanonicalCommandView[] | null {
  let latest: StoredCanonicalEvent | null = null;
  for (const run of runs) {
    for (const e of run.canonical) {
      if (e.kind === "commands.updated" && (latest === null || e.deliverySeq > latest.deliverySeq)) latest = e;
    }
  }
  if (!latest) return null;
  return [...(latest.catalog ?? [])].map((c) => ({
    name: c.name,
    description: c.description ?? null,
    input: c.input ?? null,
  }));
}

/** Parse a step's native ids from code_json (mirrors native-ids.nativeOf). */
function nativeOfStep(step: ApiStep): { partID: string | null; messageID: string | null } {
  const cj = (step as { code_json?: string | null }).code_json;
  if (!cj) return { partID: null, messageID: null };
  try {
    const n = (JSON.parse(cj) as { native?: { partID?: string; messageID?: string } }).native;
    return { partID: n?.partID ?? null, messageID: n?.messageID ?? null };
  } catch {
    return { partID: null, messageID: null };
  }
}
