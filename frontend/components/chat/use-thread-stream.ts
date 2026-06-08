"use client";

import {
  createThreadConnection,
  decodeApiRun,
  decodeApiStep,
  type DecodedFrame,
  decodeFrame,
  type EventSourceLike,
  THREAD_FRAME_TYPES,
  type ThreadConnection,
  RUN_STATUSES,
} from "@useagent/agent-client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import type { StoredCanonicalEvent } from "./canonical-timeline";
import { EXECUTION_SUMMARY_ROLLOUT_MODE } from "./execution-summary-rollout";
import { parseNativeFrame } from "./native-events";
import { createThreadStore, type ThreadSnapshot, type ThreadStore } from "./thread-store";
import { type ApiRun, toThread } from "./types";

const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUSES);

// useThreadStream — the session page's realtime unit (final_fix.md §4.7). ONE
// EventSource to the thread endpoint for the page lifetime, keyed by the ROOT thread
// id (NOT the active/newest/running run). Creating/queueing/starting/settling/
// cancelling a run never resets the store or reconnects. The reconnect / health /
// fallback-poll state machine lives in a pure, injectable controller
// (thread-connection.ts) so it is deterministically testable.

export interface ReconcileResult {
  readonly ok: boolean;
  readonly runs?: ApiRun[];
}

export interface ThreadStreamState {
  snapshot: ThreadSnapshot;
  /** One-shot safety-net reconcile: fetch the durable thread once and MERGE it.
   *  Returns a typed result (never swallowed to void) so callers can react to a
   *  failed fetch instead of assuming success. */
  reconcile: () => Promise<ReconcileResult>;
  /** Merge already-decoded runs into the thread store (a windowed island fetch)
   *  - the same applySnapshot merge the reconcile path uses, without refetching
   *  the whole thread. */
  mergeRuns: (runs: readonly ApiRun[]) => void;
}

/** Create + seed a store for a thread. Seeds from `initialThread` ONLY when it
 *  actually belongs to this root, so a stale SSR payload from a previously-viewed
 *  thread never bleeds into a new one (Codex finding 2). Pure + testable. */
export function seedThreadStore(rootRunId: string, initialThread: readonly ApiRun[]): ThreadStore {
  const store = createThreadStore({
    rootThreadId: rootRunId,
    executionSummaryEnabled: EXECUTION_SUMMARY_ROLLOUT_MODE !== "off",
  });
  if (initialThread.length && initialThread[0]?.id === rootRunId) {
    store.applySnapshot([...initialThread]);
  }
  return store;
}

/** Whether an accepted optimistic reply can be retired: only once its durable run
 *  is present in the thread store, matched by run id (never prompt text — Codex
 *  finding 4). Pure + testable. */
export function shouldRetireOptimistic(
  runId: string | null | undefined,
  snapshot: ThreadSnapshot,
): boolean {
  return runId != null && snapshot.byId.has(runId);
}

/** Fetch the whole durable thread (oldest→newest), or null on any failure. */
async function fetchThread(rootRunId: string): Promise<ApiRun[] | null> {
  try {
    const res = await backendFetch(`/api/runs/${rootRunId}?thread=1`, { cache: "no-store" });
    if (!res.ok) return null;
    const runs = toThread(await res.json());
    return runs.length ? runs : null;
  } catch {
    return null;
  }
}

/** Apply ONE decoded thread frame to the addressed run's slice. The client library
 *  (`@useagent/agent-client`) owns the wire decode + canonical envelope validation
 *  (H4-equivalent: schemaVersion/kind/ids/seq/deliverySeq/revision/thread); this thin
 *  product adapter maps the typed frame onto the store's native + canonical lanes.
 *  Unknown/malformed frames are ignored (bounded), never applied or fatal. */
export function applyDecodedFrame(store: ThreadStore, frame: DecodedFrame): void {
  switch (frame.kind) {
    case "canonical":
      // The wire event is the same shape the store's canonical lane stores; the client
      // added deliverySeq/revision and validated the envelope. One cast at the
      // package<->product type boundary (runtime shape is identical + already validated).
      store.applyCanonical(frame.event as unknown as StoredCanonicalEvent);
      return;
    case "canonical-complete":
      // H2: mark a run's canonical projection trustworthy. Until this arrives the render
      // path stays on the legacy native lane even if provisional canonical rows exist.
      store.markCanonicalComplete(frame.complete.runId);
      return;
    case "raw": {
      const p = frame.payload;
      switch (frame.type) {
        case "snapshot": {
          const runs = toThread({ thread: (p as { runs?: unknown }).runs });
          if (runs.length) store.applySnapshot(runs);
          return;
        }
        case "run": {
          const run = decodeApiRun((p as { run?: unknown }).run);
          if (run) store.upsertRun(run);
          return;
        }
        case "step": {
          const runId = p.runId as string | undefined;
          const step = decodeApiStep((p as { step?: unknown }).step);
          if (runId && step) store.applyStep(runId, step);
          return;
        }
        case "delta": {
          const runId = p.runId as string | undefined;
          const delta = p.delta;
          // `kind: "reasoning"` tags a live thinking delta (subdued Thinking
          // affordance); any other/absent value is answer narration.
          const kind = p.kind === "reasoning" ? "reasoning" : undefined;
          if (runId && typeof delta === "string") store.applyDelta(runId, delta, kind);
          return;
        }
        case "native": {
          const runId = p.runId as string | undefined;
          if (!runId) return;
          const nf = parseNativeFrame((p as { frame?: unknown }).frame);
          if (nf) store.applyNative(runId, nf);
          return;
        }
        case "done": {
          const runId = p.runId as string | undefined;
          const status = typeof p.status === "string" && RUN_STATUS_SET.has(p.status)
            ? p.status as (typeof RUN_STATUSES)[number]
            : null;
          if (runId && status) store.applyDone(runId, status);
          return;
        }
      }
      return;
    }
    case "unknown":
    case "malformed":
      return;
  }
}

/** Browser EventSource adapted to the controller's minimal EventSourceLike. */
function browserEventSource(url: string): EventSourceLike {
  const es = new EventSource(url);
  const adapter: EventSourceLike = {
    addEventListener: (type, fn) =>
      es.addEventListener(type, (e) => fn({ data: (e as MessageEvent).data })),
    close: () => es.close(),
    onopen: null,
    onerror: null,
  };
  es.onopen = () => adapter.onopen?.();
  es.onerror = () => adapter.onerror?.();
  return adapter;
}

export function useThreadStream(rootRunId: string, initialThread: ApiRun[]): ThreadStreamState {
  // Store lifetime is keyed by the ROOT thread id: recreate + reseed when rootRunId
  // changes, but NOT when a run is added to the same thread (adjust-state-on-prop-
  // change — cheaper + flicker-free vs. remount-by-key; Codex finding 2).
  const [store, setStore] = useState<ThreadStore>(() => seedThreadStore(rootRunId, initialThread));
  const [storeRoot, setStoreRoot] = useState(rootRunId);
  if (rootRunId !== storeRoot) {
    setStore(seedThreadStore(rootRunId, initialThread));
    setStoreRoot(rootRunId);
  }
  const storeRef = useRef(store);
  storeRef.current = store;

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const reconcile = useCallback(async (): Promise<ReconcileResult> => {
    const runs = await fetchThread(rootRunId);
    if (!runs) return { ok: false };
    storeRef.current.applySnapshot(runs);
    return { ok: true, runs };
  }, [rootRunId]);

  const mergeRuns = useCallback((runs: readonly ApiRun[]) => {
    if (runs.length > 0) storeRef.current.applySnapshot(runs);
  }, []);

  useEffect(() => {
    const active = storeRef.current;
    // Coalesce SSE frames: opening a long SETTLED run replays hundreds of native
    // frames back-to-back (this run: 463 frames / ~1MB). Applying each immediately
    // notifies the store per frame -> a full re-render + timeline rebuild of the
    // whole (growing) timeline each time = O(n^2) over ~1MB, which froze the tab for
    // minutes. Buffer frames and apply the burst in ONE store.batch() per animation
    // frame -> a single render for the burst (opencode-style "apply burst, paint once").
    let buffer: { event: string; data: string }[] = [];
    let scheduled: ReturnType<typeof setTimeout> | number | null = null;
    let conn: ThreadConnection | null = null;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
    const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null;
    const flushFrames = (): void => {
      scheduled = null;
      if (buffer.length === 0) return;
      const burst = buffer;
      buffer = [];
      active.batch(() => {
        for (const f of burst) {
          const frame = decodeFrame(f.event, f.data);
          applyDecodedFrame(active, frame);
          if (
            frame.kind === "canonical-complete"
          ) {
            conn?.requestSettlementReconcile(frame.complete.runId);
          } else if (frame.kind === "raw" && frame.type === "done") {
            const runId = frame.payload.runId;
            if (typeof runId === "string") conn?.requestSettlementReconcile(runId);
          }
        }
      });
    };
    const onFrame = (event: string, data: string): void => {
      buffer.push({ event, data });
      if (scheduled != null) return;
      scheduled = raf ? raf(flushFrames) : setTimeout(flushFrames, 0);
    };
    const reconcileSettlement = async (runId: string): Promise<boolean> => {
      const runs = await fetchThread(rootRunId);
      if (!runs) return false;
      active.applySnapshot(runs);
      const run = runs.find((candidate) => candidate.id === runId);
      return !!run && run.status !== "queued" && run.status !== "running";
    };
    conn = createThreadConnection({
      url: `/api/runs/${rootRunId}/thread-events`,
      frameTypes: THREAD_FRAME_TYPES,
      healthFrame: "snapshot",
      createEventSource: browserEventSource,
      onFrame,
      poll: () => {
        void fetchThread(rootRunId).then((runs) => {
          if (runs) active.applySnapshot(runs);
        });
      },
      reconcileSettlement,
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
      },
    });
    conn.start();
    return () => {
      if (scheduled != null) {
        if (raf && caf) caf(scheduled as number);
        else clearTimeout(scheduled as ReturnType<typeof setTimeout>);
      }
      conn.stop();
    };
    // Keyed by the ROOT thread id ONLY: a new run in the same thread never tears
    // down/reopens the connection; a genuine thread navigation does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRunId]);

  return { snapshot, reconcile, mergeRuns };
}
