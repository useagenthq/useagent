"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

import { fetchSidebarRuns } from "@/app/agent/runs/runs-data";
import { useOrgChanges } from "@/hooks/use-org-changes";
import type { OrgChange } from "@/lib/org-changes";
import type { SidebarRun } from "./working-project-status";

const SidebarThreadsContext = createContext<readonly SidebarRun[] | null>(null);

export function refreshesSidebarThreads(change: OrgChange): boolean {
  return change.type === "run" || (change.type === "automation" && change.action === "fired");
}

/** Owns the shell's single thread snapshot and refreshes it from the shared SSE. */
export function SidebarThreadsProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<SidebarRun[]>([]);

  const load = useCallback(async (revalidate = false) => {
    try {
      setRuns(await fetchSidebarRuns({ revalidate }));
    } catch {
      // Keep the last good shell snapshot on transient auth/network failures.
    }
  }, []);

  useOrgChanges((change) => {
    if (refreshesSidebarThreads(change)) void load(true);
  });

  useEffect(() => {
    void load();
  }, [load]);

  return <SidebarThreadsContext value={runs}>{children}</SidebarThreadsContext>;
}

export function useSidebarThreads(): readonly SidebarRun[] {
  const runs = useContext(SidebarThreadsContext);
  if (runs === null)
    throw new Error("useSidebarThreads must be used inside SidebarThreadsProvider");
  return runs;
}
