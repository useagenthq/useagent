"use client";

import { decodeApiRunLifecycle } from "@useagent/agent-client/wire";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";
import {
  createTaskSoundReconciler,
  openThreadIdFromPath,
  overtakenActiveRuns,
  type ThreadState,
  taskSoundSignals,
} from "@/lib/task-sounds";
import { taskSounds } from "@/lib/task-sounds-player";
import { useSidebarThreads } from "./sidebar-threads-provider";
import { effectiveSidebarRunStatus, type SidebarRun } from "./working-project-status";

function threadState(run: SidebarRun): ThreadState {
  return {
    id: run.id,
    latestRunId: run.latest_run_id ?? run.id,
    status: effectiveSidebarRunStatus(run),
    cancelled: run.latest_cancelled ?? false,
  };
}

async function fetchExactThreadState(runId: string): Promise<ThreadState | null> {
  try {
    const response = await backendFetch(`/api/runs/${encodeURIComponent(runId)}?view=lifecycle`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    const run = decodeApiRunLifecycle(await response.json());
    return run
      ? {
          id: run.thread_id,
          latestRunId: run.id,
          status: run.status,
          cancelled: run.cancelled,
        }
      : null;
  } catch {
    return null;
  }
}

const isActive = (state: ThreadState) => state.status === "queued" || state.status === "running";
const MAX_OBSERVED_ACTIVE = 512;

function rememberActive(map: Map<string, ThreadState>, state: ThreadState): void {
  map.delete(state.latestRunId);
  map.set(state.latestRunId, state);
  while (map.size > MAX_OBSERVED_ACTIVE) {
    const oldest = map.keys().next().value;
    if (!oldest) break;
    map.delete(oldest);
  }
}

/**
 * Rings the task grammar from the shell's own thread snapshot, so a turn that
 * settles in any thread is heard from any page. Renders nothing. Exact reads
 * retain displaced runs, and durable cancel intent repairs missed SSE signals.
 */
export function TaskSoundCues() {
  const runs = useSidebarThreads();
  const pathname = usePathname();
  const previous = useRef<Map<string, ThreadState> | null>(null);
  const observedActive = useRef(new Map<string, ThreadState>());
  const reconcileOnce = useCallback(
    async (before: ThreadState) => {
      const next = await fetchExactThreadState(before.latestRunId);
      if (!next) return;
      const signals = taskSoundSignals(
        new Map([[before.id, before]]),
        [next],
        openThreadIdFromPath(pathname),
      );
      if (signals.length > 0 || !isActive(next) || next.cancelled) {
        observedActive.current.delete(before.latestRunId);
      } else {
        rememberActive(observedActive.current, next);
      }
      void taskSounds.signals(signals);
    },
    [pathname],
  );
  const reconcile = useMemo(() => createTaskSoundReconciler(reconcileOnce), [reconcileOnce]);

  useEffect(() => {
    const next = runs.map(threadState);
    const before = previous.current;
    if (before) {
      for (const overtaken of overtakenActiveRuns(before, next)) {
        if (observedActive.current.has(overtaken.latestRunId)) void reconcile(overtaken);
      }
      void taskSounds.signals(taskSoundSignals(before, next, openThreadIdFromPath(pathname)));
    }
    previous.current = new Map(next.map((thread) => [thread.id, thread]));
    for (const state of next) {
      if (isActive(state) && !state.cancelled) {
        rememberActive(observedActive.current, state);
      } else {
        observedActive.current.delete(state.latestRunId);
      }
    }
  }, [reconcile, runs, pathname]);

  useOrgChanges(
    (change) => {
      if (change.type !== "run") return;
      if (change.action === "created" || change.action === "running") {
        rememberActive(observedActive.current, {
          id: change.threadId,
          latestRunId: change.runId,
          status: change.action === "created" ? "queued" : "running",
          cancelled: false,
        });
        return;
      }
      const before = observedActive.current.get(change.runId) ?? {
        id: change.threadId,
        latestRunId: change.runId,
        status: "running",
        cancelled: false,
      };
      if (change.action === "cancelled") {
        observedActive.current.delete(change.runId);
        void taskSounds.signals(
          taskSoundSignals(
            new Map([[before.id, before]]),
            [{ ...before, cancelled: true }],
            openThreadIdFromPath(pathname),
          ),
        );
      } else {
        void reconcile(before);
      }
    },
    () => {
      for (const state of observedActive.current.values()) void reconcile(state);
    },
  );

  return null;
}
