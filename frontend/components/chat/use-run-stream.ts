"use client";

import { useEffect, useRef, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import type { ApiRun, ApiStep, RunStatus } from "./types";
import { isLiveStatus } from "./types";

export type RunStreamState = {
  steps: ApiStep[];
  status: RunStatus;
  summary: string | null;
  live: boolean;
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
 */
export function useRunStream(initialRun: ApiRun): RunStreamState {
  const [steps, setSteps] = useState<ApiStep[]>(initialRun.steps);
  const [status, setStatus] = useState<RunStatus>(initialRun.status);
  const [summary, setSummary] = useState<string | null>(initialRun.summary);
  const seen = useRef<Set<number>>(
    new Set(initialRun.steps.map((s) => s.idx)),
  );
  const id = initialRun.id;

  // Reset stream state when the watched run changes — a reply in the same thread
  // makes a newer run the one we stream, and its snapshot must replace the old
  // one before the effect re-subscribes. (React's "adjust state on prop change"
  // pattern: cheaper and flicker-free vs. remounting via `key`.)
  const [watchedId, setWatchedId] = useState(id);
  if (id !== watchedId) {
    setWatchedId(id);
    setSteps(initialRun.steps);
    setStatus(initialRun.status);
    setSummary(initialRun.summary);
    seen.current = new Set(initialRun.steps.map((s) => s.idx));
  }

  useEffect(() => {
    // Already finished at SSR time — nothing to stream.
    if (!isLiveStatus(initialRun.status)) return;

    let closed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const appendStep = (step: ApiStep) => {
      if (seen.current.has(step.idx)) return;
      seen.current.add(step.idx);
      setSteps((prev) =>
        [...prev, step].sort((a, b) => a.idx - b.idx),
      );
    };

    const finalize = async (next: RunStatus) => {
      setStatus(next);
      try {
        const res = await backendFetch(`/api/runs/${id}`);
        if (res.ok) {
          const run = (await res.json()) as ApiRun;
          setSummary(run.summary);
          run.steps.forEach(appendStep);
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
          run.steps.forEach(appendStep);
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
          appendStep(JSON.parse((e as MessageEvent).data) as ApiStep);
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
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return { steps, status, summary, live: isLiveStatus(status) };
}
