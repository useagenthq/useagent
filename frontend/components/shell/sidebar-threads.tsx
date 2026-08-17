"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { fetchRuns, type Run } from "@/app/agent/runs/runs-data";
import { T3ThreadRow } from "@/components/t3-ui/thread-row";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { SidebarSectionLabel } from "./sidebar-nav";

const POLL_MS = 30_000;
const MAX = 8;

/**
 * The sidebar thread list, rendered with the vendored T3 thread-row treatment
 * (components/t3-ui/thread-row.tsx). Same data lane as the Active-runs surface
 * (`fetchRuns` + org-change invalidation + a low-frequency recovery poll);
 * supersedes SidebarRecents' row rendering. Client leaf so the server
 * `ThreadSidebar` stays static; renders nothing until at least one run exists
 * (no empty-section furniture).
 */
export function SidebarThreads() {
  const pathname = usePathname();
  const [runs, setRuns] = useState<Run[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setRuns(await fetchRuns(signal));
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useOrgChanges((change) => {
    if (change.type === "run") void load();
  });

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const id = setInterval(() => void load(controller.signal), POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [load]);

  return (
    <>
      <SidebarSectionLabel>Threads</SidebarSectionLabel>
      {runs.length === 0 ? (
        <p className="px-2.5 py-2 text-paragraph-xs text-text-soft-400">
          {status === "loading"
            ? "Loading threads..."
            : status === "error"
              ? "Threads unavailable"
              : "No threads yet"}
        </p>
      ) : null}
      {runs.slice(0, MAX).map((run) => {
        const href = `/session/${run.id}`;
        return <T3ThreadRow key={run.id} run={run} href={href} active={pathname === href} />;
      })}
    </>
  );
}
