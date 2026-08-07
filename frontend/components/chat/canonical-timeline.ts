// Phase 1: the canonical -> timeline reducer (frontend view policy).
//
// The backend translator is LOSSLESS; the DISPLAY POLICY lives here. This reduces a
// canonical event stream (ordered by Skynet seq) into the same TimelineNode[] the
// legacy buildTimeline produces, so React can consume canonical instead of the two
// native lanes. Slice 2 proves byte-for-byte equivalence on the protected fixture
// (canonical-timeline.equiv.test); the React cutover (behind a legacy fallback)
// only lands after that gate is green.
//
// Node detail (the ApiStep) still comes from the durable step sidecar keyed by the
// canonical event's identity.nativeEventId - the "bounded raw sidecar" the doc keeps
// for rendering. Moving detail into the canonical payload is a later, additive step.

import { deriveTrace, type ApiStep } from "./types";
import { isNarration, type TimelineNode } from "./timeline";

/** Minimal structural view of a canonical event (the reducer needs only these). */
export interface CanonicalEventLike {
  readonly kind: string;
  readonly seq: number;
  readonly identity?: { readonly nativeEventId?: string; readonly nativeSessionId?: string };
}

/**
 * Reduce canonical events into timeline nodes, applying the SAME display policy as
 * buildTimeline: tool ROWS come from step-sourced tool.completed events (identity.
 * nativeEventId -> the ApiStep in `stepsById`), skipping `done`, narration, and
 * (when settled) boot rows. Frame-sourced tool events (whose nativeEventId is not a
 * step id) are the live/structural signal and produce no settled node. `live` keeps
 * boot rows, exactly like buildTimeline.
 */
export function buildTimelineFromCanonical(
  events: readonly CanonicalEventLike[],
  stepsById: ReadonlyMap<string, ApiStep>,
  live = false,
): TimelineNode[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const nodes: TimelineNode[] = [];
  for (const e of ordered) {
    if (e.kind !== "tool.completed") continue; // text/marker nodes: additive follow-up
    const id = e.identity?.nativeEventId;
    const step = id ? stepsById.get(id) : undefined;
    if (!step) continue; // frame-sourced (structural) tool signal, not a durable row
    if (step.kind === "done") continue;
    if (isNarration(step)) continue;
    if (deriveTrace(step).accent === "boot") {
      if (!live) continue;
    }
    nodes.push({ kind: "tool", key: step.id, step });
  }
  return nodes;
}
