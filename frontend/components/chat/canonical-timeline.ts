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

import { isNarration, parseMarker, type TimelineMarker, type TimelineNode } from "./timeline";
import { type ApiStep, deriveTrace, isRenderableTimelineStep } from "./types";

/** Structural view of a canonical event (envelope base + flattened body fields). */
export interface CanonicalEventLike {
  readonly kind: string;
  readonly seq: number;
  readonly ts?: number;
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
  readonly parentChildId?: string;
  readonly launchToolCallId?: string;
  readonly markerType?: string;
  readonly title?: string;
  readonly detail?: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly input?: unknown;
  readonly server?: string;
  readonly preview?: string;
  readonly status?: string;
  readonly nativeStatus?: string;
  readonly durationMs?: number;
  readonly result?: string;
  readonly error?: string;
  readonly entries?: readonly {
    readonly id: string;
    readonly text: string;
    readonly status: "pending" | "in_progress" | "completed" | "cancelled";
  }[];
  readonly path?: string;
  readonly changeType?: "create" | "edit" | "delete";
  readonly diff?: {
    readonly artifactId: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly contentType: string;
  };
  readonly terminalId?: string;
  readonly chunk?: string;
  readonly message?: string;
  readonly fatal?: boolean;
  readonly rawEventType?: string;
  readonly rawPayload?: unknown;
  readonly destination?: string;
  readonly artifact?: {
    readonly artifactId: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly contentType: string;
  };
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
  /** `session.started` body: the ONE negotiated capability map the UI gates surfaces on. */
  readonly capabilities?: Readonly<Record<string, boolean>>;
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
export function validateCanonicalEvent(
  raw: unknown,
  frameThreadId: unknown,
): StoredCanonicalEvent | null {
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
  if (e.identity !== undefined && (typeof e.identity !== "object" || e.identity === null))
    return null;
  return e as unknown as StoredCanonicalEvent;
}

/** The render-path gate (H2+H4): use the canonical timeline for a turn ONLY when the flag
 *  is on AND the run's canonicalization reached its durable completion record AND there
 *  are canonical rows. A still-provisional (incomplete) or empty lane falls back to legacy,
 *  so a partial/retrying snapshot never renders. Pure, so both flag states are testable. */
export function shouldUseCanonicalTimeline(
  flagOn: boolean,
  turn: {
    readonly canonical?: readonly CanonicalEventLike[];
    readonly canonicalComplete?: boolean;
  },
): boolean {
  return flagOn && turn.canonicalComplete === true && !!turn.canonical && turn.canonical.length > 0;
}

/** Validate a canonical-complete frame's `complete` payload (H4). */
export function validateCanonicalComplete(
  raw: unknown,
  frameThreadId: unknown,
): { runId: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (!isNonEmptyString(c.runId)) return null;
  if (
    isNonEmptyString(frameThreadId) &&
    isNonEmptyString(c.threadId) &&
    c.threadId !== frameThreadId
  )
    return null;
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
    return {
      kind: "skill",
      playbook: t === "playbook",
      name: e.title ?? "skill",
      version: 0,
      hash: "",
    };
  }
  if (t === "memory") {
    return { kind: "memory", op: "remember", scope: "org", failed: false, reconciled: false };
  }
  return { kind: "context", source: t ?? "context", itemCount: 0, query: null };
}

type Ranked = { node: TimelineNode; k0: number; k1: number; k2: number };
const MAX = Number.MAX_SAFE_INTEGER;

interface ToolLifecycle {
  readonly toolCallId: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly nativeEventIds: readonly string[];
  readonly name: string;
  readonly title: string;
  readonly input?: unknown;
  readonly server?: string;
  readonly preview?: string;
  readonly status?: string;
  readonly nativeStatus?: string;
  readonly durationMs?: number;
  readonly error?: string;
}

function projectedStep(
  event: CanonicalEventLike,
  shape: Pick<ApiStep, "kind" | "label" | "chip"> & { readonly code: Record<string, unknown> },
  id = event.identity?.nativeEventId ?? `${event.kind}-${event.seq}`,
): ApiStep {
  return {
    id,
    run_id: "",
    idx: event.seq,
    kind: shape.kind,
    label: shape.label,
    chip: shape.chip,
    code_json: JSON.stringify(shape.code),
    created_at: new Date(0).toISOString(),
  };
}

function collectToolLifecycles(
  events: readonly CanonicalEventLike[],
): ReadonlyMap<string, ToolLifecycle> {
  const mutable = new Map<string, ToolLifecycle>();
  for (const event of events) {
    if (
      (event.kind !== "tool.started" &&
        event.kind !== "tool.progress" &&
        event.kind !== "tool.completed") ||
      !event.toolCallId
    ) {
      continue;
    }
    const previous = mutable.get(event.toolCallId);
    const nativeEventId = event.identity?.nativeEventId;
    mutable.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      firstSeq: previous?.firstSeq ?? event.seq,
      lastSeq: event.seq,
      nativeEventIds: nativeEventId
        ? [...(previous?.nativeEventIds ?? []), nativeEventId]
        : (previous?.nativeEventIds ?? []),
      name: event.name ?? previous?.name ?? "tool",
      title: event.title ?? previous?.title ?? event.name ?? "Tool",
      input: event.input ?? previous?.input,
      server: event.server ?? previous?.server,
      preview: event.preview ?? previous?.preview,
      status: event.status ?? previous?.status,
      nativeStatus: event.nativeStatus ?? previous?.nativeStatus,
      durationMs: event.durationMs ?? previous?.durationMs,
      error: event.error ?? previous?.error,
    });
  }
  return mutable;
}

function projectToolLifecycle(lifecycle: ToolLifecycle, event: CanonicalEventLike): ApiStep {
  const detail = lifecycle.error ?? lifecycle.preview;
  return projectedStep(
    event,
    {
      kind: "command",
      label: lifecycle.title,
      chip: null,
      code: {
        tool: lifecycle.name,
        ...(lifecycle.server ? { server: lifecycle.server } : {}),
        ...(lifecycle.input === undefined ? {} : { input: lifecycle.input }),
        ...(detail === undefined ? {} : { output: detail }),
        ...(lifecycle.nativeStatus ? { status: lifecycle.nativeStatus } : {}),
        ...(lifecycle.durationMs === undefined ? {} : { durationMs: lifecycle.durationMs }),
        ...(lifecycle.status === "error" || lifecycle.error ? { error: true } : {}),
      },
    },
    `canonical-tool-${lifecycle.toolCallId}`,
  );
}

export function buildTimelineFromCanonical(
  events: readonly CanonicalEventLike[],
  stepsById: ReadonlyMap<string, ApiStep>,
  live = false,
): TimelineNode[] {
  const ordered = events.toSorted((a, b) => a.seq - b.seq);
  const toolLifecycles = collectToolLifecycles(ordered);
  const latestPlanSeq = ordered.reduce(
    (latest, event) => (event.kind === "plan.updated" ? Math.max(latest, event.seq) : latest),
    -1,
  );

  // Pass 1: derive the same ordering inputs buildTimeline builds from frames.
  const childSessions = new Set<string>();
  const msgOrderKey = new Map<string, number>(); // messageId -> anchor (step-start) seq
  const partMessage = new Map<string, string>(); // partId -> messageId
  const stepMessages = new Set<string>(); // messages that began (step-start)
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
  const seenReasoningPart = new Set<string>();

  for (const e of ordered) {
    // ── context markers (skynet lane): lead the turn ──────────────────────────
    if (e.kind === "context.marker") {
      ranked.push({
        node: {
          kind: "marker",
          key: e.identity?.nativeEventId ?? String(e.seq),
          marker: toTimelineMarker(e),
        },
        k0: -2,
        k1: 0,
        k2: e.identity?.nativeSeq ?? e.seq,
      });
      continue;
    }
    if (
      (e.kind === "artifact.created" || e.kind === "artifact.delivered") &&
      e.artifact &&
      e.name
    ) {
      ranked.push({
        node: {
          kind: "artifact",
          key: e.identity?.nativeEventId ?? String(e.seq),
          artifact: {
            id: e.artifact.artifactId,
            name: e.name,
            bytes: e.artifact.bytes,
            sha256: e.artifact.sha256,
            contentType: e.artifact.contentType,
            ...(e.kind === "artifact.delivered" && e.destination
              ? { destination: e.destination }
              : {}),
          },
        },
        k0: MAX,
        k1: 2,
        k2: e.identity?.nativeSeq ?? e.seq,
      });
      continue;
    }
    // ── assistant text bursts (root, step-messages only; child text -> its pane) ─
    if (e.kind === "message.delta") {
      const sid = e.identity?.nativeSessionId;
      const mid = e.messageId;
      if (sid && childSessions.has(sid)) continue; // subagent chatter
      if (!mid || !stepMessages.has(mid)) continue; // injected context / user prompt
      if (!e.text?.trim()) continue;
      const key = e.identity?.nativePartId ?? e.identity?.nativeEventId ?? String(e.seq);
      if (seenTextPart.has(key)) continue; // one burst per part (latest wins by seq order)
      seenTextPart.add(key);
      ranked.push({
        node: { kind: "text", key, text: e.text },
        k0: msgOrderKey.get(mid) ?? e.identity?.nativeSeq ?? e.seq,
        k1: 0,
        k2: e.identity?.nativeSeq ?? e.seq,
      });
      continue;
    }
    // ── reasoning ("thinking") bursts: root-session only, one node per part; the
    //    delta carries the text, reasoning.completed just seals it. Ordered by the
    //    part's own native seq, mirroring buildTimeline's reasoning loop exactly. ──
    if (e.kind === "reasoning.delta") {
      const sid = e.identity?.nativeSessionId;
      if (sid && childSessions.has(sid)) continue; // subagent thinking -> its pane
      if (!e.text?.trim()) continue;
      const key = e.identity?.nativePartId ?? e.identity?.nativeEventId ?? String(e.seq);
      if (seenReasoningPart.has(key)) continue;
      seenReasoningPart.add(key);
      ranked.push({
        node: { kind: "reasoning", key, text: e.text },
        k0: e.identity?.nativeSeq ?? e.seq,
        k1: 0,
        k2: e.identity?.nativeSeq ?? e.seq,
      });
      continue;
    }
    // ── plan snapshot: only the latest provider-neutral plan is current ──────
    if (e.kind === "plan.updated" && e.seq === latestPlanSeq && e.entries?.length) {
      ranked.push({
        node: {
          kind: "plan",
          key: e.identity?.nativeEventId ?? String(e.seq),
          entries: e.entries,
        },
        k0: e.seq,
        k1: 1,
        k2: e.seq,
      });
      continue;
    }
    // ── file receipts: the diff is an out-of-band ref, never fabricated body ─
    if (e.kind === "file.changed" && e.path && e.changeType) {
      ranked.push({
        node: {
          kind: "file",
          key: e.identity?.nativeEventId ?? String(e.seq),
          file: {
            path: e.path,
            changeType: e.changeType,
            ...(e.diff ? { diff: e.diff } : {}),
          },
        },
        k0: e.seq,
        k1: 1,
        k2: e.seq,
      });
      continue;
    }
    // ── direct terminal output and harness diagnostics remain observable ─────
    if (e.kind === "terminal.output" && e.chunk) {
      const step = projectedStep(e, {
        kind: "command",
        label: e.terminalId ?? "Terminal",
        chip: null,
        code: {
          tool: "terminal",
          input: { name: e.terminalId ?? "terminal" },
          output: e.chunk,
        },
      });
      ranked.push({ node: { kind: "tool", key: step.id, step }, k0: e.seq, k1: 1, k2: e.seq });
      continue;
    }
    if ((e.kind === "harness.warning" || e.kind === "harness.error") && e.message) {
      const error = e.kind === "harness.error";
      let rawDetail: string | undefined;
      if (e.rawPayload !== undefined) {
        try {
          rawDetail = JSON.stringify(e.rawPayload, null, 2);
        } catch {
          rawDetail = "Native payload could not be serialized";
        }
      }
      const step = projectedStep(e, {
        kind: "command",
        label: e.message,
        chip: null,
        code: {
          tool: error ? "error" : "warning",
          input: { description: e.rawEventType ?? e.message },
          ...(rawDetail ? { output: rawDetail } : {}),
          ...(error ? { error: true } : {}),
        },
      });
      ranked.push({ node: { kind: "tool", key: step.id, step }, k0: e.seq, k1: 1, k2: e.seq });
      continue;
    }
    // ── legacy tool receipt: early canonical rows identified only the durable
    //    sidecar step. Preserve that exact row while newer translators fold the
    //    full toolCallId lifecycle below. ─────────────────────────────────────
    if (e.kind === "tool.completed" && !e.toolCallId && e.identity?.nativeEventId) {
      const step = stepsById.get(e.identity.nativeEventId);
      if (!step || step.kind === "done" || !isRenderableTimelineStep(step) || isNarration(step))
        continue;
      const boot = deriveTrace(step).accent === "boot";
      if (boot && !live) continue;
      const ids = nativeOfStep(step);
      const mid = (ids.partID && partMessage.get(ids.partID)) || ids.messageID || null;
      ranked.push({
        node: { kind: "tool", key: step.id, step },
        k0: boot ? -1 : mid ? (msgOrderKey.get(mid) ?? MAX) : e.seq,
        k1: 1,
        k2: step.idx,
      });
      continue;
    }
    // ── tool rows: lifecycle-folded rows, filtered like buildTimeline ─────────
    if (
      (e.kind === "tool.started" || e.kind === "tool.progress" || e.kind === "tool.completed") &&
      e.toolCallId
    ) {
      const lifecycle = toolLifecycles.get(e.toolCallId);
      if (!lifecycle || e.seq !== lifecycle.lastSeq) continue;
      const step =
        lifecycle.nativeEventIds
          .toReversed()
          .map((id) => stepsById.get(id))
          .find((candidate): candidate is ApiStep => candidate !== undefined) ??
        projectToolLifecycle(lifecycle, e);
      if (step.kind === "done") continue;
      if (!isRenderableTimelineStep(step)) continue;
      if (isNarration(step)) continue;
      const boot = deriveTrace(step).accent === "boot";
      if (boot && !live) continue;
      const ids = nativeOfStep(step);
      const mid = (ids.partID && partMessage.get(ids.partID)) || ids.messageID || null;
      ranked.push({
        node: { kind: "tool", key: step.id, step },
        k0: boot ? -1 : mid ? (msgOrderKey.get(mid) ?? MAX) : lifecycle.firstSeq,
        k1: 1,
        k2: step.idx,
      });
    }
  }

  return ranked.toSorted((a, b) => a.k0 - b.k0 || a.k1 - b.k1 || a.k2 - b.k2).map((r) => r.node);
}

export type {
  CanonicalCommandView,
  CommandCatalogState,
  SessionCommandCatalog,
} from "./canonical-session";
export {
  resolveCommandCatalog,
  selectActiveSessionId,
  selectSessionCapabilities,
  selectSessionCommandCatalog,
  selectSessionCommands,
} from "./canonical-session";

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
