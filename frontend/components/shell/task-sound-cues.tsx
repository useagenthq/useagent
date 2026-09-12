"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { useOrgChanges } from "@/hooks/use-org-changes";
import { openThreadIdFromPath, type ThreadState, taskMoments } from "@/lib/task-sounds";
import { taskSounds } from "@/lib/task-sounds-player";
import { useSidebarThreads } from "./sidebar-threads-provider";
import { effectiveSidebarRunStatus, type SidebarRun } from "./working-project-status";

function threadState(run: SidebarRun): ThreadState {
  return {
    id: run.id,
    latestRunId: run.latest_run_id ?? run.id,
    status: effectiveSidebarRunStatus(run),
  };
}

/**
 * Rings the task grammar from the shell's own thread snapshot, so a turn that
 * settles in any thread is heard from any page. Renders nothing. Cancellations
 * come straight off the org change stream, because a cancelled run keeps no
 * status of its own in the snapshot.
 */
export function TaskSoundCues() {
  const runs = useSidebarThreads();
  const pathname = usePathname();
  const previous = useRef<Map<string, ThreadState> | null>(null);

  useEffect(() => {
    const next = runs.map(threadState);
    taskSounds.moments(taskMoments(previous.current, next, openThreadIdFromPath(pathname)));
    previous.current = new Map(next.map((thread) => [thread.id, thread]));
  }, [runs, pathname]);

  useOrgChanges((change) => {
    if (change.type === "run" && change.action === "cancelled") taskSounds.moment("cancelled");
  });

  return null;
}
