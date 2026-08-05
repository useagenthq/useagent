"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import type { ApiRun, ApiStep, RunStatus } from "./types";
import { isLiveStatus } from "./types";
import { createNativeStore, type NativeSnapshot, type NativeStore } from "./native-store";

export type RunStreamState = {
  steps: ApiStep[];
  status: RunStatus;
  summary: string | null;
  live: boolean;
  /** Live narration text streamed over `delta` events while the run is live
   *  (token-level typing feel). Cleared when the run reaches a terminal state —
   *  the durable summary/steps take over. */
  liveText: string;
  /** Native-ID projection (parts by partID, tools by callID, children by
   *  sessionID with parent linkage) of this run's step stream — the ID-backed
   *  substrate for attribution. `steps` above is its idx-ordered, native-deduped
   *  compatibility projection (north-star Phase 4: store coexists with the
   *  ApiStep path). */
  native: NativeSnapshot;
};

/**
 * Subscribes to a run's server-sent event stream (`GET /api/runs/:id/events`),
 * live-appending `step` events and closing on `done`. The backend replays all
 * persisted steps on connect, so the SSR snapshot and the stream converge
 * without gaps. If EventSource fails (proxy hiccup, older browser), it falls
 * back to polling the run every 5s until it reaches a terminal state.
 *
 * The `done` event carries only `{id, status}`, so on completion we fetch the
 * run once more to pick up the final `summary` the worker wrote.
 *
 * Steps flow through a small native session store (`native-store.ts`) that
 * dedupes by the OpenCode native part/call id the backend stamps into
 * `code_json.native`. That collapses SSE↔poller overlap and running→completed
 * re-emits onto one row, and exposes the native parts/tools/children maps —
 * without changing the `ApiStep[]` shape callers already consume.
 */
export function useRunStream(initialRun: ApiRun): RunStreamState {
  const [status, setStatus] = useState<RunStatus>(initialRun.status);
  const [summary, setSummary] = useState<string | null>(initialRun.summary);
  const [liveText, setLiveText] = useState("");
  const id = initialRun.id;

  // The native store owns the step projection (dedupe + idx ordering). One
  // stable instance for the hook's life (lazy init seeds it); reset() reseeds
  // it on a run switch.
  const genRef = useRef(0);
  const [store] = useState<NativeStore>(() => {
    const s = createNativeStore();
    s.reset(initialRun.steps, 0);
    return s;
  });

  // Reset stream state when the watched run changes — a reply in the same thread
  // makes a newer run the one we stream, and its snapshot must replace the old
  // one before the effect re-subscribes. (React's "adjust state on prop change"
  // pattern: cheaper and flicker-free vs. remounting via `key`.) Bumping the
  // generation makes the store drop any in-flight async ingest from the old run.
  const [watchedId, setWatchedId] = useState(id);
  if (id !== watchedId) {
    setWatchedId(id);
    genRef.current += 1;
    store.reset(initialRun.steps, genRef.current);
    setStatus(initialRun.status);
    setSummary(initialRun.summary);
    setLiveText("");
  }

  const native = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  useEffect(() => {
    // Already finished at SSR time — nothing to stream.
    if (!isLiveStatus(initialRun.status)) return;

    // Captured at subscribe time — the generation guard. If the run switches
    // mid-flight, the store's current generation has advanced and these stale
    // ingests are dropped.
    const gen = genRef.current;
    let closed = false;
    const staleGuard = new AbortController();
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const finalize = async (next: RunStatus) => {
      setStatus(next);
      setLiveText("");
      try {
        const res = await backendFetch(`/api/runs/${id}`);
        // `staleGuard` aborts in cleanup when the watched run changes — a late
        // resolution for the OLD run must not overwrite the new run's state.
        if (res.ok && !staleGuard.signal.aborted) {
          const run = (await res.json()) as ApiRun;
          if (staleGuard.signal.aborted) return;
          setSummary(run.summary);
          store.ingestAll(run.steps, gen);
        }
      } catch {
        // keep whatever we have
      }
    };

    const startPolling = () => {
      if (pollTimer) return;
      pollTimer = setInterval(async () => {
        try {
          const res = await backendFetch(`/api/runs/${id}`);
          if (!res.ok) return;
          const run = (await res.json()) as ApiRun;
          store.ingestAll(run.steps, gen);
          setSummary(run.summary);
          if (!isLiveStatus(run.status)) {
            setStatus(run.status);
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
          }
        } catch {
          // transient — try again next tick
        }
      }, 5000);
    };

    let source: EventSource | null = null;
    try {
      source = new EventSource(`/api/runs/${id}/events`);
      source.addEventListener("step", (e) => {
        try {
          store.ingest(JSON.parse((e as MessageEvent).data) as ApiStep, gen);
        } catch {
          /* ignore malformed frame */
        }
      });
      source.addEventListener("delta", (e) => {
        try {
          const d = (JSON.parse((e as MessageEvent).data) as { delta?: string }).delta;
          if (typeof d === "string" && d) setLiveText((prev) => prev + d);
        } catch {
          /* ignore malformed frame */
        }
      });
      source.addEventListener("done", (e) => {
        let next: RunStatus = "completed";
        try {
          next = (JSON.parse((e as MessageEvent).data).status as RunStatus) ?? "completed";
        } catch {
          /* default completed */
        }
        closed = true;
        source?.close();
        void finalize(next);
      });
      source.onerror = () => {
        // EventSource auto-retries; if it can't connect, back it up with polling.
        if (!closed) startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      closed = true;
      staleGuard.abort();
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return {
    steps: native.steps,
    status,
    summary,
    live: isLiveStatus(status),
    liveText,
    native,
  };
}
