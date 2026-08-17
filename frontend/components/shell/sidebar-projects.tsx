"use client";

import { RiArrowDownSLine, RiArrowUpSLine, RiFolderLine } from "@remixicon/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchRuns } from "@/app/agent/runs/runs-data";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";
import { SidebarNavItem, SidebarSectionLabel } from "./sidebar-nav";
import {
  activeRunByRepo,
  WorkingProjectStatus,
  type SidebarRun,
} from "./working-project-status";

interface ProjectRepo {
  readonly fullName: string;
  readonly name: string;
}

/** Always-visible shortcut rows; the rest sit behind a disclosure so the
 *  Threads section below never gets pushed out of view. */
const VISIBLE_PROJECTS = 5;
const MAX_PROJECTS = 48;
const POLL_MS = 30_000;

export function SidebarProjects() {
  const [projects, setProjects] = useState<ProjectRepo[]>([]);
  const [runs, setRuns] = useState<SidebarRun[]>([]);
  const [expanded, setExpanded] = useState(false);

  const loadProjects = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await backendFetch("/api/repos", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) return;
      const data = (await response.json()) as {
        repos?: Array<{ full_name?: unknown; name?: unknown }>;
      };
      const repos = (data.repos ?? [])
        .flatMap((repo): ProjectRepo[] => {
          if (typeof repo.full_name !== "string" || repo.full_name.length === 0) return [];
          return [
            {
              fullName: repo.full_name,
              name:
                typeof repo.name === "string" && repo.name.length > 0 ? repo.name : repo.full_name,
            },
          ];
        })
        .slice(0, MAX_PROJECTS);
      setProjects(repos);
    } catch {
      // Ambient navigation stays quiet on authentication or fetch failures.
    }
  }, []);

  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    try {
      setRuns((await fetchRuns(signal)) as SidebarRun[]);
    } catch {
      // Status chips are additive; project shortcuts still render from /api/repos.
    }
  }, []);

  useOrgChanges((change) => {
    if (change.type === "run" || (change.type === "automation" && change.action === "fired")) {
      void loadRuns();
    }
    if (change.type === "provider_connection") void loadProjects();
  });

  useEffect(() => {
    const controller = new AbortController();
    void loadProjects(controller.signal);
    void loadRuns(controller.signal);
    const id = setInterval(() => {
      void loadProjects(controller.signal);
      void loadRuns(controller.signal);
    }, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [loadProjects, loadRuns]);

  const activeByRepo = useMemo(() => activeRunByRepo(runs), [runs]);

  if (projects.length === 0) return null;

  const visible = projects.slice(0, VISIBLE_PROJECTS);
  const overflow = projects.slice(VISIBLE_PROJECTS);

  const projectRow = (project: ProjectRepo) => (
    <SidebarNavItem
      key={project.fullName}
      href={`/agent/new?repo=${encodeURIComponent(project.fullName)}`}
      icon={RiFolderLine}
      label={project.name}
      trailing={<WorkingProjectStatus run={activeByRepo.get(project.fullName)} />}
    />
  );

  return (
    <>
      <SidebarSectionLabel>Projects</SidebarSectionLabel>
      {visible.map(projectRow)}
      {overflow.length > 0 ? (
        <>
          {expanded ? (
            <div className="max-h-56 overflow-y-auto">{overflow.map(projectRow)}</div>
          ) : null}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-paragraph-xs text-text-soft-400 transition-colors hover:bg-bg-weak-50 hover:text-text-sub-600"
          >
            {expanded ? (
              <RiArrowUpSLine className="size-4" aria-hidden />
            ) : (
              <RiArrowDownSLine className="size-4" aria-hidden />
            )}
            {expanded ? "Show fewer" : `Show ${overflow.length} more`}
          </button>
        </>
      ) : null}
    </>
  );
}
