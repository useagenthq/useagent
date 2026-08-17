"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchRuns, type Run, statusTone, TONE_TO_DOT } from "@/app/agent/runs/runs-data";
import { StatusDot } from "@/components/shared/status-dot";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { SidebarNavItem, SidebarSectionLabel } from "./sidebar-nav";
import { WorkingProjectStatus, type SidebarRun } from "./working-project-status";

const POLL_MS = 30_000;
const MAX = 8;

/**
 * The sidebar thread list, wired to real runs. Reuses the Active-runs data
 * layer (`fetchRuns` + `statusTone` + the shared `TONE_TO_DOT` map) rather than
 * duplicating the fetch, and renders the newest runs as links into their
 * session. Client leaf so the server `ThreadSidebar` stays static; renders
 * nothing until at least one run exists (no empty-section furniture).
 */
export function SidebarRecents() {
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
      {runs.slice(0, MAX).map((run) => (
        <SidebarNavItem
          key={run.id}
          href={`/session/${run.id}`}
          label={run.prompt || "Untitled run"}
          leading={<StatusDot {...TONE_TO_DOT[statusTone(run.status)]} />}
          trailing={<WorkingProjectStatus run={run as SidebarRun} />}
        />
      ))}
    </>
  );
}
