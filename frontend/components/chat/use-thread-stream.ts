"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import { toThread, type ApiRun, type ApiStep, type RunStatus } from "./types";
import { parseNativeFrame } from "./native-events";
import { createThreadStore, type ThreadSnapshot, type ThreadStore } from "./thread-store";

// useThreadStream — the session page's realtime unit (final_fix.md §4.7). ONE
// EventSource to the thread endpoint for the whole page lifetime, keyed by the
// ROOT thread id (NOT the active/newest/running run). Creating, queueing,
// starting, completing, or cancelling a run must NOT reset the store or reconnect:
// every frame is routed to the addressed run's slice inside the thread store.
//
// Reconnect replays a full authoritative snapshot (no cursor); the store's native
// dedupe makes that idempotent. A five-second full-thread poll runs ONLY as a
// transport-failure fallback after bounded SSE reconnect attempts, and stops the
// instant SSE reconnects — so SSE and polling never both write the store.

const MAX_SSE_ATTEMPTS = 5;

export function useThreadStream(rootRunId: string, initialThread: ApiRun[]): ThreadSnapshot {
  // One store for the page lifetime, seeded from the SSR thread so first paint is
  // instant and the SSE snapshot later merges (never resets) onto it.
  const [store] = useState<ThreadStore>(() => {
    const s = createThreadStore();
    if (initialThread.length) s.applySnapshot(initialThread);
    return s;
  });
  const storeRef = useRef(store);
  storeRef.current = store;

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    const s = storeRef.current;
    let closed = false;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let attempts = 0;

    const stopPolling = (): void => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    // Fallback ONLY: engaged after bounded SSE failure; a healthy reconnect stops it.
    const startPolling = (): void => {
      if (pollTimer || closed) return;
      pollTimer = setInterval(async () => {
        try {
          const res = await backendFetch(`/api/runs/${rootRunId}?thread=1`);
          if (!res.ok) return;
          const runs = toThread(await res.json());
          if (runs.length) s.applySnapshot(runs);
        } catch {
          // transient — next tick retries
        }
      }, 5000);
    };

    const connect = (): void => {
      if (closed) return;
      try {
        source = new EventSource(`/api/runs/${rootRunId}/thread-events`);
      } catch {
        startPolling();
        return;
      }
      source.addEventListener("snapshot", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as { runs?: unknown };
          const runs = toThread({ thread: data.runs });
          if (runs.length) s.applySnapshot(runs);
        } catch {
          /* ignore malformed frame */
        }
      });
      source.addEventListener("run", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as { run?: ApiRun };
          if (data.run && typeof data.run.id === "string") s.upsertRun(data.run);
        } catch {
          /* ignore */
        }
      });
      source.addEventListener("step", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as { runId?: string; step?: ApiStep };
          if (data.runId && data.step) s.applyStep(data.runId, data.step);
        } catch {
          /* ignore */
        }
      });
      source.addEventListener("delta", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as { runId?: string; delta?: string };
          if (data.runId && typeof data.delta === "string") s.applyDelta(data.runId, data.delta);
        } catch {
          /* ignore */
        }
      });
      source.addEventListener("native", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as { runId?: string; frame?: unknown };
          if (!data.runId) return;
          const frame = parseNativeFrame(data.frame);
          if (frame) s.applyNative(data.runId, frame);
        } catch {
          /* ignore */
        }
      });
      source.addEventListener("done", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as { runId?: string; status?: RunStatus };
          if (data.runId && data.status) s.applyDone(data.runId, data.status);
        } catch {
          /* ignore */
        }
      });
      source.onopen = () => {
        // A healthy connection resets the backoff and cancels any fallback poll —
        // SSE is the single writer whenever it is up.
        attempts = 0;
        stopPolling();
      };
      source.onerror = () => {
        if (closed) return;
        source?.close();
        source = null;
        attempts += 1;
        // Engage the fallback poll only after bounded SSE failures; keep probing
        // SSE regardless, so recovery re-establishes the single stream and stops
        // the poll (onopen).
        if (attempts >= MAX_SSE_ATTEMPTS) startPolling();
        reconnectTimer = setTimeout(connect, Math.min(1000 * attempts, 5000));
      };
    };
    connect();

    return () => {
      closed = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPolling();
    };
    // Keyed by the root thread id ONLY — never by the active/newest/running run,
    // so adding a run never tears down and reopens the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRunId]);

  return snapshot;
}
