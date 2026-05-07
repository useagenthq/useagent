// Native session projection store — north-star Phase 4 ("React Store").
//
// Indexes the run's EXISTING ApiStep stream by the stable OpenCode native ids
// the backend now stamps into `code_json.native` (commit 83c6439:
// `{sessionID, messageID, partID, callID}` on tools, `{sessionID, partID,
// childSessionID}` on subtasks). This is the ID-backed substrate that lets
// attribution stop relying on display order or "↳" label prefixes.
//
// It COEXISTS with the current Turn/steps path: alongside the native maps it
// emits an idx-ordered, native-deduped compatibility projection (`steps`) that
// `useRunStream` returns unchanged in shape, so every existing ApiStep consumer
// keeps working during the migration. It is a small emitter store (subscribe /
// getSnapshot) consumed via `useSyncExternalStore`.

import type { ApiStep } from "./types";
import { nativeOf, type NativeIds } from "./native-ids";
import type { NativeFrame } from "./native-events";

/** A child (subagent) native session, discovered from a parent's subtask step. */
export interface NativeChild {
  sessionID: string;
  parentSessionID: string | null;
  /** The step that announced it (the subtask), for card rendering. */
  originStepId: string | null;
}

export interface NativeSnapshot {
  /** Compatibility projection: idx-ordered, native-deduped ApiStep list. */
  steps: ApiStep[];
  /** Every stored step keyed by its native part id (dedupe/enrichment target). */
  parts: ReadonlyMap<string, ApiStep>;
  /** Tool steps keyed by their native call id. */
  tools: ReadonlyMap<string, ApiStep>;
  /** Child native sessions keyed by session id, with parent linkage. */
  children: ReadonlyMap<string, NativeChild>;
  /** Set of child session ids — attribute a step to a child when its
   *  `native.sessionID` is in here (native nesting, not the "↳" heuristic). */
  childSessionIds: ReadonlySet<string>;
  /** Lossless native frames seen for this run, deduped by eventId at the highest
   *  seq, ordered by seq — the substrate for child status/text derivation. */
  nativeFrames: readonly NativeFrame[];
  /** Highest native `seq` seen (reconnect cursor); -1 before any frame. */
  nativeCursor: number;
  /** Bumped by reset() — lets consumers detect a session switch. */
  generation: number;
}

export interface NativeStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): NativeSnapshot;
  /** Replace all state with `steps` for a new generation (session switch).
   *  Silent by design — reset is always render-driven, and React re-reads
   *  getSnapshot after the render that triggered it. */
  reset(steps: readonly ApiStep[], generation: number): void;
  /** Ingest/enrich one step; a stale `generation` is ignored (the guard). Returns
   *  whether it applied (false = dropped) so callers avoid a getSnapshot rebuild
   *  just to detect change - critical under burst replay (avoids O(n^2)). */
  ingest(step: ApiStep, generation: number): boolean;
  /** Ingest many steps at the given generation (poll/finalize reconcile). */
  ingestAll(steps: readonly ApiStep[], generation: number): void;
  /** Ingest a native frame; deduped by eventId keeping the highest seq, so a
   *  live↔replay overlap and part revisions collapse. Stale generation / stale seq
   *  ignored. Returns whether it applied (false = deduped/dropped). */
  ingestNative(frame: NativeFrame, generation: number): boolean;
}

const EMPTY_SNAPSHOT: NativeSnapshot = {
  steps: [],
  parts: new Map(),
  tools: new Map(),
  children: new Map(),
  childSessionIds: new Set(),
  nativeFrames: [],
  nativeCursor: -1,
  generation: 0,
};

/**
 * The dedupe key for a step: prefer the native part id, then the call id, then
 * fall back to the run-unique idx. Enriched re-emits and poll/SSE overlap carry
 * the same native id, so they collapse onto one record instead of duplicating.
 */
function dedupeKey(step: ApiStep, ids: NativeIds | null): string {
  return ids?.partID ?? ids?.callID ?? `idx:${step.idx}`;
}

/** Build the immutable snapshot from the canonical record + frame maps (pure). */
function buildSnapshot(
  records: ReadonlyMap<string, ApiStep>,
  frames: ReadonlyMap<string, NativeFrame>,
  generation: number,
): NativeSnapshot {
  const steps = [...records.values()].sort((a, b) => a.idx - b.idx);
  const parts = new Map<string, ApiStep>();
  const tools = new Map<string, ApiStep>();
  const children = new Map<string, NativeChild>();
  for (const step of steps) {
    const ids = nativeOf(step);
    if (ids?.partID) parts.set(ids.partID, step);
    if (ids?.callID) tools.set(ids.callID, step);
    if (ids?.childSessionID) {
      children.set(ids.childSessionID, {
        sessionID: ids.childSessionID,
        parentSessionID: ids.sessionID ?? null,
        originStepId: step.id,
      });
    }
  }
  const nativeFrames = [...frames.values()].sort((a, b) => a.seq - b.seq);
  const nativeCursor = nativeFrames.reduce((max, f) => Math.max(max, f.seq), -1);
  return {
    steps,
    parts,
    tools,
    children,
    childSessionIds: new Set(children.keys()),
    nativeFrames,
    nativeCursor,
    generation,
  };
}

/** Create a native session store. Deterministic: the snapshot is a pure
 *  function of the ingested steps and the current generation. */
export function createNativeStore(): NativeStore {
  const records = new Map<string, ApiStep>();
  const frames = new Map<string, NativeFrame>();
  let generation = 0;
  const listeners = new Set<() => void>();
  let snapshot: NativeSnapshot | null = null;

  const notify = () => {
    snapshot = null; // invalidate cache; rebuilt lazily on read
    for (const l of listeners) l();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      if (records.size === 0 && frames.size === 0 && generation === 0) return EMPTY_SNAPSHOT;
      if (!snapshot) snapshot = buildSnapshot(records, frames, generation);
      return snapshot;
    },
    reset(steps, gen) {
      records.clear();
      frames.clear();
      generation = gen;
      for (const step of steps) records.set(dedupeKey(step, nativeOf(step)), step);
      snapshot = null; // silent: render-driven, React re-reads getSnapshot
    },
    ingest(step, gen) {
      if (gen !== generation) return false; // generation guard — drop stale writes
      records.set(dedupeKey(step, nativeOf(step)), step);
      notify();
      return true;
    },
    ingestAll(steps, gen) {
      if (gen !== generation) return;
      for (const step of steps) records.set(dedupeKey(step, nativeOf(step)), step);
      notify();
    },
    ingestNative(frame, gen) {
      if (gen !== generation) return false;
      const seen = frames.get(frame.eventId);
      if (seen && seen.seq >= frame.seq) return false; // dedupe: keep the highest seq → no change
      frames.set(frame.eventId, frame);
      notify();
      return true;
    },
  };
}
