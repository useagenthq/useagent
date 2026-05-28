// Thread-owned projection store (final_fix.md §4.6) — the lifetime + reconciliation
// boundary for a whole useAgent conversation, NOT whichever run is selected.
//
// It does NOT reimplement native dedupe/child-attribution/sorting: each run's
// projection is an INSTANCE of the existing per-run `createNativeStore`, and this
// store is the thread-keyed OWNER that multiplexes many runs and aggregates their
// snapshots. Adding/queueing/starting/settling a run mutates only that run's slice;
// no run switch ever resets another run's tools, native frames, children, or
// summary. Store lifetime changes only when the root thread id changes (the hook
// recreates it), so a constant generation is sufficient here.

import type { StoredCanonicalEvent } from "./canonical-timeline";
import type { NativeFrame } from "./native-events";
import { createNativeStore, type NativeSnapshot, type NativeStore } from "./native-store";
import { type ApiRun, type ApiStep, isLiveStatus, type RunStatus } from "./types";

/** One run's view within the thread: its metadata + live/settled projection. */
export interface ThreadRunView {
  run: ApiRun;
  status: RunStatus;
  summary: string | null;
  /** Transient live narration for this run; "" once settled. */
  liveText: string;
  /** Transient live provider "thinking" for this run, surfaced as a subdued
   *  Thinking affordance ahead of the answer; "" once settled. */
  liveReasoning: string;
  /** The run's native-id projection (reused per-run native store snapshot). */
  native: NativeSnapshot;
  /** The run's canonical events (final_harness Phase 1), latest revision per eventId,
   *  ordered by deliverySeq. Empty until the canonical lane populates; the render path
   *  uses it only behind the canonical-timeline flag (legacy native lane is default). */
  canonical: readonly StoredCanonicalEvent[];
  /** H2: whether this run's canonicalization reached the durable `complete` record. The
   *  render path trusts the canonical lane ONLY when true - provisional rows (still being
   *  retried by the outbox) never drive the UI, so a partial snapshot can't render. */
  canonicalComplete: boolean;
}

export interface ThreadSnapshot {
  /** Every run in the thread, oldest→newest. */
  runs: ApiRun[];
  /** Per-run view keyed by runId. */
  byId: ReadonlyMap<string, ThreadRunView>;
}

export interface ThreadStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ThreadSnapshot;
  /** Apply many mutations, then notify listeners ONCE. A burst of frames (e.g. an
   *  SSE replay of hundreds of native frames when opening a long settled run) would
   *  otherwise notify per frame → a full re-render + timeline rebuild each time
   *  (O(n^2), the 600-frame run froze the tab for minutes). Batching folds the burst
   *  into a single render, opencode-style "apply the burst, paint once". */
  batch(apply: () => void): void;
  /** Hydrate/reconcile the complete durable thread. Merges (never resets): adding
   *  a run leaves every other run's slice intact. */
  applySnapshot(runs: readonly ApiRun[]): void;
  /** Upsert ONE run without replacing the others. */
  upsertRun(run: ApiRun): void;
  /** Upsert a step onto the addressed run only. */
  applyStep(runId: string, step: ApiStep): void;
  /** Append a transient live delta to the addressed run only. `kind` "reasoning"
   *  feeds the live Thinking buffer; otherwise the answer narration buffer. */
  applyDelta(runId: string, delta: string, kind?: "reasoning"): void;
  /** Update the addressed run's native lane only (highest seq wins). */
  applyNative(runId: string, frame: NativeFrame): void;
  /** Add a canonical event to its run's lane (latest revision per eventId wins). */
  applyCanonical(event: StoredCanonicalEvent): void;
  /** Mark a run's canonicalization COMPLETE (H2): the render path may now trust its
   *  canonical lane. Idempotent. */
  markCanonicalComplete(runId: string): void;
  /** Settle the addressed run and clear only its transient text. */
  applyDone(runId: string, status: RunStatus): void;
}

const EMPTY_SNAPSHOT: ThreadSnapshot = { runs: [], byId: new Map() };

export function createThreadStore(): ThreadStore {
  // Ordered run ids (oldest→newest) + per-run slices.
  const order: string[] = [];
  const runs = new Map<string, ApiRun>();
  const status = new Map<string, RunStatus>();
  const summary = new Map<string, string | null>();
  const liveText = new Map<string, string>();
  const liveReasoning = new Map<string, string>();
  const stores = new Map<string, NativeStore>();
  // Canonical lane (final_harness Phase 1): per-run eventId -> latest-revision event.
  const canonicalByRun = new Map<string, Map<string, StoredCanonicalEvent>>();
  // H2: runs whose canonicalization reached the durable `complete` record (trustworthy).
  const canonicalCompleteRuns = new Set<string>();

  const listeners = new Set<() => void>();
  let snapshot: ThreadSnapshot | null = null;

  // Batch depth: while > 0, mutations invalidate the snapshot but defer the single
  // listener flush to batch-end (so an SSE replay burst renders once, not per frame).
  let batchDepth = 0;
  let pendingNotify = false;
  const flush = (): void => {
    for (const l of listeners) l();
  };
  const notify = (): void => {
    snapshot = null; // invalidate; rebuilt lazily on read
    if (batchDepth > 0) {
      pendingNotify = true;
      return;
    }
    flush();
  };

  /** Ensure a run has a native store + an order slot (idempotent). */
  const ensureStore = (runId: string): NativeStore => {
    let s = stores.get(runId);
    if (!s) {
      s = createNativeStore();
      stores.set(runId, s);
    }
    return s;
  };

  // A live payload is stronger evidence than a stale queued projection. The durable
  // queued->running signal normally arrives first, but reconnect/replay races can deliver a
  // step, text delta, or native frame before that metadata refresh. Promote only queued runs;
  // late frames can never reopen a terminal run.
  const markRunActive = (runId: string): void => {
    if (status.get(runId) === "queued") status.set(runId, "running");
  };

  /** Merge one run's durable projection into its slice (add if new). */
  const mergeRun = (run: ApiRun): void => {
    if (!runs.has(run.id)) order.push(run.id);
    runs.set(run.id, run);
    status.set(run.id, run.status);
    summary.set(run.id, run.summary);
    if (!liveText.has(run.id)) liveText.set(run.id, "");
    if (!liveReasoning.has(run.id)) liveReasoning.set(run.id, "");
    // A fresh DB read is authoritative for durable steps; ingestAll merges (dedupe
    // by native id / idx), so a live-enriched step is never regressed.
    ensureStore(run.id).ingestAll(run.steps, 0);
    // A settled run carries no live narration; its summary/steps are the truth.
    if (!isLiveStatus(run.status)) {
      liveText.set(run.id, "");
      liveReasoning.set(run.id, "");
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    batch(apply) {
      batchDepth++;
      try {
        apply();
      } finally {
        batchDepth--;
        if (batchDepth === 0 && pendingNotify) {
          pendingNotify = false;
          flush();
        }
      }
    },

    getSnapshot() {
      if (snapshot) return snapshot;
      if (order.length === 0) {
        snapshot = EMPTY_SNAPSHOT;
        return snapshot;
      }
      const runsList: ApiRun[] = [];
      const byId = new Map<string, ThreadRunView>();
      for (const id of order) {
        const run = runs.get(id);
        if (!run) continue; // step/native arrived before its run frame — skip until it does
        runsList.push(run);
        const canonMap = canonicalByRun.get(id);
        byId.set(id, {
          run,
          status: status.get(id) ?? run.status,
          summary: summary.get(id) ?? run.summary,
          liveText: liveText.get(id) ?? "",
          liveReasoning: liveReasoning.get(id) ?? "",
          native: ensureStore(id).getSnapshot(),
          canonical: canonMap
            ? [...canonMap.values()].sort((a, b) => a.deliverySeq - b.deliverySeq)
            : [],
          canonicalComplete: canonicalCompleteRuns.has(id),
        });
      }
      snapshot = { runs: runsList, byId };
      return snapshot;
    },

    applySnapshot(runsIn) {
      for (const run of runsIn) mergeRun(run);
      notify();
    },

    upsertRun(run) {
      mergeRun(run);
      notify();
    },

    applyStep(runId, step) {
      // ingest returns whether it changed - so we never rebuild the native snapshot
      // just to detect a no-op (that before/after getSnapshot compare was O(n) per
      // call, i.e. O(n^2) across a burst replay). Same suppression, no rebuild.
      const wasQueued = status.get(runId) === "queued";
      const changed = ensureStore(runId).ingest(step, 0);
      if (step.kind !== "done") markRunActive(runId);
      if (changed || (wasQueued && step.kind !== "done")) notify();
    },

    applyDelta(runId, delta, kind) {
      if (!delta) return;
      markRunActive(runId);
      if (kind === "reasoning") {
        liveReasoning.set(runId, (liveReasoning.get(runId) ?? "") + delta);
      } else {
        liveText.set(runId, (liveText.get(runId) ?? "") + delta);
      }
      notify();
    },

    applyNative(runId, frame) {
      // Highest-seq-wins dedupe lives in ingestNative; it returns whether it applied,
      // so a stale/duplicate frame is dropped WITHOUT a snapshot rebuild. This is the
      // hot path on a settled-run replay (hundreds of frames) - keep it O(1)/frame.
      const wasQueued = status.get(runId) === "queued";
      const changed = ensureStore(runId).ingestNative(frame, 0);
      markRunActive(runId);
      if (changed || wasQueued) notify();
    },

    applyCanonical(event) {
      // Latest revision per eventId wins; a stale/duplicate revision is dropped
      // WITHOUT a snapshot rebuild (hot path on a canonical replay burst).
      let m = canonicalByRun.get(event.runId);
      if (!m) {
        m = new Map();
        canonicalByRun.set(event.runId, m);
      }
      const prev = m.get(event.eventId);
      if (prev && prev.revision >= event.revision) return;
      m.set(event.eventId, event);
      notify();
    },

    markCanonicalComplete(runId) {
      if (canonicalCompleteRuns.has(runId)) return; // idempotent - no rebuild on a repeat
      canonicalCompleteRuns.add(runId);
      notify();
    },

    applyDone(runId, nextStatus) {
      status.set(runId, nextStatus);
      liveText.set(runId, ""); // transient text is not reconnect truth
      liveReasoning.set(runId, ""); // thinking is live-only, cleared on settle
      notify();
    },
  };
}
