// Thread-owned projection store (final_fix.md §4.6) — the lifetime + reconciliation
// boundary for a whole Skynet conversation, NOT whichever run is selected.
//
// It does NOT reimplement native dedupe/child-attribution/sorting: each run's
// projection is an INSTANCE of the existing per-run `createNativeStore`, and this
// store is the thread-keyed OWNER that multiplexes many runs and aggregates their
// snapshots. Adding/queueing/starting/settling a run mutates only that run's slice;
// no run switch ever resets another run's tools, native frames, children, or
// summary. Store lifetime changes only when the root thread id changes (the hook
// recreates it), so a constant generation is sufficient here.

import { createNativeStore, type NativeSnapshot, type NativeStore } from "./native-store";
import type { NativeFrame } from "./native-events";
import { isLiveStatus, type ApiRun, type ApiStep, type RunStatus } from "./types";

/** One run's view within the thread: its metadata + live/settled projection. */
export interface ThreadRunView {
  run: ApiRun;
  status: RunStatus;
  summary: string | null;
  /** Transient live narration for this run; "" once settled. */
  liveText: string;
  /** The run's native-id projection (reused per-run native store snapshot). */
  native: NativeSnapshot;
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
  /** Append transient narration to the addressed run only. */
  applyDelta(runId: string, delta: string): void;
  /** Update the addressed run's native lane only (highest seq wins). */
  applyNative(runId: string, frame: NativeFrame): void;
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
  const stores = new Map<string, NativeStore>();

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

  /** Merge one run's durable projection into its slice (add if new). */
  const mergeRun = (run: ApiRun): void => {
    if (!runs.has(run.id)) order.push(run.id);
    runs.set(run.id, run);
    status.set(run.id, run.status);
    summary.set(run.id, run.summary);
    if (!liveText.has(run.id)) liveText.set(run.id, "");
    // A fresh DB read is authoritative for durable steps; ingestAll merges (dedupe
    // by native id / idx), so a live-enriched step is never regressed.
    ensureStore(run.id).ingestAll(run.steps, 0);
    // A settled run carries no live narration; its summary/steps are the truth.
    if (!isLiveStatus(run.status)) liveText.set(run.id, "");
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
        byId.set(id, {
          run,
          status: status.get(id) ?? run.status,
          summary: summary.get(id) ?? run.summary,
          liveText: liveText.get(id) ?? "",
          native: ensureStore(id).getSnapshot(),
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
      if (ensureStore(runId).ingest(step, 0)) notify();
    },

    applyDelta(runId, delta) {
      if (!delta) return;
      liveText.set(runId, (liveText.get(runId) ?? "") + delta);
      notify();
    },

    applyNative(runId, frame) {
      // Highest-seq-wins dedupe lives in ingestNative; it returns whether it applied,
      // so a stale/duplicate frame is dropped WITHOUT a snapshot rebuild. This is the
      // hot path on a settled-run replay (hundreds of frames) - keep it O(1)/frame.
      if (ensureStore(runId).ingestNative(frame, 0)) notify();
    },

    applyDone(runId, nextStatus) {
      status.set(runId, nextStatus);
      liveText.set(runId, ""); // transient text is not reconnect truth
      notify();
    },
  };
}
