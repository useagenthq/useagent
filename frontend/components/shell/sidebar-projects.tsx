"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchSidebarRuns } from "@/app/agent/runs/runs-data";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { backendFetch } from "@/lib/backend-fetch";
import { threadRowTimestamp } from "@/components/session-ui/thread-row";
import {
  ProjectThreadTree,
  type ProjectGroup as TreeProjectGroup,
  type ProjectMenuControl,
} from "@/components/session-ui/project-thread-tree";
import { relativeTime } from "@/utils/format";
import {
  groupThreadsByProject,
  runPrimaryRepo,
  UNATTACHED_KEY,
  type ProjectRepo,
} from "./sidebar-project-groups";
import { SidebarProjectMenu } from "./sidebar-project-menu";
import { SidebarSectionLabel } from "./sidebar-nav";
import type { SidebarRun } from "./working-project-status";

const POLL_MS = 30_000;
const MAX_PROJECTS = 48;
const STORAGE_KEY = "useagent.sidebar.project-expanded";

/** Per-project expand overrides, best-effort (private mode / SSR safe). */
function readExpanded(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeExpanded(value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* private mode / storage full - expand state is best-effort */
  }
}

/**
 * The project-nested thread rail, rendered with the native Board UI repos-tree
 * treatment (folder -> folder-open, grid-rows height animation, curved tree
 * connector, relative-time chips) and a per-project actions menu (hover kebab +
 * right-click). Data still comes from the two existing lanes - GET /api/repos
 * (the full project list) and the runs summary (threads + their repo) - folded
 * into project groups by `groupThreadsByProject`. No new endpoints.
 *
 * Same refresh contract as before: an org-change subscription plus a
 * low-frequency recovery poll. Expanded/collapsed state is remembered per
 * project in localStorage; by default the active thread's project and the most
 * recent project open. Client leaf so the server `ThreadSidebar` stays static.
 */
export function SidebarProjects() {
  const pathname = usePathname();
  const [projects, setProjects] = useState<ProjectRepo[]>([]);
  const [runs, setRuns] = useState<SidebarRun[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setOverrides(readExpanded());
  }, []);

  const loadProjects = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await backendFetch("/api/repos", { cache: "no-store", signal });
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

  const loadRuns = useCallback(async (revalidate = false) => {
    try {
      setRuns(await fetchSidebarRuns({ revalidate }));
    } catch {
      // Threads are additive; project shortcuts still render from /api/repos.
    }
  }, []);

  useOrgChanges((change) => {
    if (change.type === "run" || (change.type === "automation" && change.action === "fired")) {
      void loadRuns(true);
    }
    if (change.type === "provider_connection") void loadProjects();
  });

  useEffect(() => {
    const controller = new AbortController();
    void loadProjects(controller.signal);
    void loadRuns();
    const id = setInterval(() => {
      void loadProjects(controller.signal);
      void loadRuns(true);
    }, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [loadProjects, loadRuns]);

  const groups = useMemo(() => groupThreadsByProject(runs, projects), [runs, projects]);

  // Default-open the active thread's project plus the most recent one; explicit
  // user toggles (stored) win over the default.
  const defaultExpanded = useMemo(() => {
    const set = new Set<string>();
    if (groups[0]) set.add(groups[0].key);
    const activeRun = runs.find((run) => pathname === `/session/${run.id}`);
    if (activeRun) set.add(runPrimaryRepo(activeRun) ?? UNATTACHED_KEY);
    return set;
  }, [groups, runs, pathname]);

  const isExpanded = (key: string) =>
    key in overrides ? overrides[key] : defaultExpanded.has(key);

  const toggle = (key: string) => {
    setOverrides((prev) => {
      const next = { ...prev, [key]: !isExpanded(key) };
      writeExpanded(next);
      return next;
    });
  };

  // Fold the data groups into the tree view model: a title, the clean repo name
  // for the actions menu, and each thread's label + real relative-time chip +
  // active-state from the current route.
  const treeGroups = useMemo<TreeProjectGroup[]>(
    () =>
      groups.map((group) => ({
        key: group.key,
        label: group.name,
        fullName: group.fullName,
        threads: group.threads.map((run) => ({
          id: run.id,
          label: run.prompt || "Untitled run",
          time: relativeTime(threadRowTimestamp(run)),
          isSelected: pathname === `/session/${run.id}`,
        })),
      })),
    [groups, pathname],
  );

  const renderMenu = useCallback(
    (group: TreeProjectGroup, control: ProjectMenuControl) =>
      group.fullName ? (
        <SidebarProjectMenu group={group} isOpen={control.isOpen} setOpen={control.setOpen} />
      ) : null,
    [],
  );

  if (groups.length === 0) return null;

  return (
    <>
      <SidebarSectionLabel>Projects</SidebarSectionLabel>
      <ProjectThreadTree
        groups={treeGroups}
        isExpanded={isExpanded}
        onToggle={toggle}
        threadHref={(thread) => `/session/${thread.id}`}
        renderMenu={renderMenu}
      />
    </>
  );
}
