"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import { toThread, type ApiRun, type ApiStep, type RunStatus } from "./types";
import { parseNativeFrame } from "./native-events";
import { createThreadStore, type ThreadSnapshot, type ThreadStore } from "./thread-store";
import { createThreadConnection, type EventSourceLike, type ThreadConnection } from "./thread-connection";

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
}

const FRAME_TYPES = ["snapshot", "run", "step", "delta", "native", "done"] as const;

/** Create + seed a store for a thread. Seeds from `initialThread` ONLY when it
 *  actually belongs to this root, so a stale SSR payload from a previously-viewed
 *  thread never bleeds into a new one (Codex finding 2). Pure + testable. */
export function seedThreadStore(rootRunId: string, initialThread: readonly ApiRun[]): ThreadStore {
  const store = createThreadStore();
  if (initialThread.length && initialThread[0]?.id === rootRunId) {
    store.applySnapshot(initialThread as ApiRun[]);
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
    const res = await backendFetch(`/api/runs/${rootRunId}?thread=1`);
    if (!res.ok) return null;
    const runs = toThread(await res.json());
    return runs.length ? runs : null;
  } catch {
    return null;
  }
}

/** Route one raw SSE frame to the addressed run's slice. Malformed frames ignored. */
function dispatchFrame(store: ThreadStore, event: string, data: string): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (event) {
    case "snapshot": {
      const runs = toThread({ thread: (parsed as { runs?: unknown }).runs });
      if (runs.length) store.applySnapshot(runs);
      return;
    }
    case "run": {
      const run = (parsed as { run?: ApiRun }).run;
      if (run && typeof run.id === "string") store.upsertRun(run);
      return;
    }
    case "step": {
      const runId = parsed.runId as string | undefined;
      const step = (parsed as { step?: ApiStep }).step;
      if (runId && step) store.applyStep(runId, step);
      return;
    }
    case "delta": {
      const runId = parsed.runId as string | undefined;
      const delta = parsed.delta;
      if (runId && typeof delta === "string") store.applyDelta(runId, delta);
      return;
    }
    case "native": {
      const runId = parsed.runId as string | undefined;
      if (!runId) return;
      const frame = parseNativeFrame((parsed as { frame?: unknown }).frame);
      if (frame) store.applyNative(runId, frame);
      return;
    }
    case "done": {
      const runId = parsed.runId as string | undefined;
      const status = parsed.status as RunStatus | undefined;
      if (runId && status) store.applyDone(runId, status);
      return;
    }
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

  useEffect(() => {
    const active = storeRef.current;
    const conn: ThreadConnection = createThreadConnection({
      url: `/api/runs/${rootRunId}/thread-events`,
      frameTypes: FRAME_TYPES,
      healthFrame: "snapshot",
      createEventSource: browserEventSource,
      onFrame: (event, data) => dispatchFrame(active, event, data),
      poll: () => {
        void fetchThread(rootRunId).then((runs) => {
          if (runs) active.applySnapshot(runs);
        });
      },
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
      },
    });
    conn.start();
    return () => conn.stop();
    // Keyed by the ROOT thread id ONLY: a new run in the same thread never tears
    // down/reopens the connection; a genuine thread navigation does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRunId]);

  return { snapshot, reconcile };
}
