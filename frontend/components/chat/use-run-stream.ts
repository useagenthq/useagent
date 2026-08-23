"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import { createThreadConnection, type EventSourceLike, type ThreadConnection } from "@useagent/agent-client";
import type { ApiRun, ApiStep, RunStatus } from "./types";
import { isLiveStatus } from "./types";
import { createNativeStore, type NativeSnapshot, type NativeStore } from "./native-store";
import { parseNativeFrame } from "./native-events";

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

const RUN_FRAME_TYPES = ["step", "delta", "native", "done"] as const;

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
    // Captured at subscribe time — the generation guard. If the run switches
    // mid-flight, the store's current generation has advanced and these stale
    // ingests are dropped.
    const gen = genRef.current;
    let closed = false;
    const staleGuard = new AbortController();
    let connection: ThreadConnection | null = null;
    // Native-lane reconnect cursor: the highest native `seq` seen. We reconnect
    // with `?cursor=` so replay resumes from here (the store dedupes anyway, so a
    // full replay would be correct but wasteful). -1 → replay from the start.
    let cursor = -1;

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

    const poll = () => {
      void (async () => {
        try {
          const res = await backendFetch(`/api/runs/${id}`);
          if (!res.ok) return;
          const run = (await res.json()) as ApiRun;
          store.ingestAll(run.steps, gen);
          setSummary(run.summary);
          if (!isLiveStatus(run.status)) {
            setStatus(run.status);
            connection?.stop();
          }
        } catch {
          // transient — try again next tick
        }
      })();
    };

    // Open (or reopen) the stream from the current native cursor. The shared
    // controller owns health-qualified reconnect + polling fallback, so an
    // open→immediate-error loop cannot reset attempts forever.
    connection = createThreadConnection({
      url: () => `/api/runs/${id}/events?cursor=${cursor}`,
      frameTypes: RUN_FRAME_TYPES,
      healthFrame: "step",
      createEventSource: browserEventSource,
      onFrame: (event, data) => {
        if (closed) return;
        switch (event) {
          case "step":
            try {
              store.ingest(JSON.parse(data) as ApiStep, gen);
            } catch {
              /* ignore malformed frame */
            }
            return;
          case "delta":
            try {
              const d = (JSON.parse(data) as { delta?: string }).delta;
              if (typeof d === "string" && d) setLiveText((prev) => prev + d);
            } catch {
              /* ignore malformed frame */
            }
            return;
          case "native":
            try {
              const frame = parseNativeFrame(JSON.parse(data));
              if (!frame) return; // malformed / unknown - ignore, never throw
              store.ingestNative(frame, gen);
              if (frame.seq > cursor) cursor = frame.seq; // advance the reconnect cursor
            } catch {
              /* ignore malformed frame */
            }
            return;
          case "done": {
            let next: RunStatus = "completed";
            try {
              next = (JSON.parse(data).status as RunStatus) ?? "completed";
            } catch {
              /* default completed */
            }
            closed = true;
            connection?.stop();
            void finalize(next);
            return;
          }
        }
      },
      poll,
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>),
      },
    });
    connection.start();

    return () => {
      closed = true;
      staleGuard.abort();
      connection?.stop();
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
