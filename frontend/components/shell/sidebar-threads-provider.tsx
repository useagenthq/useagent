"use client";

import type { ThreadRelationship } from "@useagent/agent-client";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { fetchSidebarRuns } from "@/app/agent/runs/runs-data";
import { useOrgChanges } from "@/hooks/use-org-changes";
import type { OrgChange } from "@/lib/org-changes";
import { fetchThreadRelationshipIndex } from "@/lib/thread-relationships-data";
import type { SidebarRun } from "./working-project-status";

const SidebarThreadsContext = createContext<readonly SidebarRun[] | null>(null);
const SidebarThreadRelationshipsContext = createContext<readonly ThreadRelationship[] | null>(null);

export function refreshesSidebarThreads(change: OrgChange): boolean {
  return (
    change.type === "run" ||
    change.type === "thread_relationship" ||
    change.type === "execution_graph" ||
    (change.type === "automation" && change.action === "fired")
  );
}

/** Owns the shell's single thread snapshot and refreshes it from the shared SSE. */
export function SidebarThreadsProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<SidebarRun[]>([]);
  const [relationships, setRelationships] = useState<readonly ThreadRelationship[]>([]);

  const load = useCallback(async (revalidate = false) => {
    try {
      const [nextRuns, nextRelationships] = await Promise.allSettled([
        fetchSidebarRuns({ revalidate }),
        fetchThreadRelationshipIndex({ revalidate }),
      ]);
      if (nextRuns.status === "fulfilled") setRuns(nextRuns.value);
      if (nextRelationships.status === "fulfilled") {
        setRelationships(nextRelationships.value.relationships);
      }
    } catch {
      // Keep the last good shell snapshot on transient auth/network failures.
    }
  }, []);

  useOrgChanges(
    (change) => {
      if (refreshesSidebarThreads(change)) void load(true);
    },
    () => void load(true),
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SidebarThreadsContext value={runs}>
      <SidebarThreadRelationshipsContext value={relationships}>
        {children}
      </SidebarThreadRelationshipsContext>
    </SidebarThreadsContext>
  );
}

export function useSidebarThreadRelationships(): readonly ThreadRelationship[] {
  const relationships = useContext(SidebarThreadRelationshipsContext);
  if (relationships === null) {
    throw new Error("useSidebarThreadRelationships must be used inside SidebarThreadsProvider");
  }
  return relationships;
}

export function useSidebarThreads(): readonly SidebarRun[] {
  const runs = useContext(SidebarThreadsContext);
  if (runs === null)
    throw new Error("useSidebarThreads must be used inside SidebarThreadsProvider");
  return runs;
}
