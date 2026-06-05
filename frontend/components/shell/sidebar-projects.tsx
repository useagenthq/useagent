"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchSidebarRuns } from "@/app/agent/runs/runs-data";
import {
  type ProjectMenuControl,
  ProjectThreadTree,
  type ProjectGroup as TreeProjectGroup,
} from "@/components/session-ui/project-thread-tree";
import { ThreadRow, threadRowTimestamp } from "@/components/session-ui/thread-row";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { useSession } from "@/lib/auth";
import { backendFetch } from "@/lib/backend-fetch";
import { relativeTime } from "@/utils/format";
import { SidebarSectionLabel } from "./sidebar-nav";
import {
  dedupeProjectRepos,
  groupThreadsByProject,
  type ProjectGroup,
  type ProjectRepo,
  runPrimaryRepo,
  UNATTACHED_KEY,
} from "./sidebar-project-groups";
import { SidebarProjectMenu } from "./sidebar-project-menu";
import type { SidebarRun } from "./working-project-status";

const POLL_MS = 30_000;
const MAX_PROJECTS = 48;
// Recent threads stay visible; the rest sit behind a "Show N more" disclosure so
// a long history never floods the rail (same cap as the previous rail).
const VISIBLE_THREADS = 6;
const STORAGE_KEY = "useagent.sidebar.project-expanded";

function storageKey(userId: string | null): string {
  return `${STORAGE_KEY}:${userId ?? "anonymous"}`;
}

/** Per-project expand overrides, best-effort (private mode / SSR safe). */
function readExpanded(userId: string | null): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    const raw = window.localStorage.getItem(storageKey(userId));
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

function writeExpanded(userId: string | null, value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(value));
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
  const { session, loading: sessionLoading } = useSession();
  const [projects, setProjects] = useState<ProjectRepo[]>([]);
  const [runs, setRuns] = useState<SidebarRun[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [showEmptyProjects, setShowEmptyProjects] = useState(false);
  const [showAllThreads, setShowAllThreads] = useState(false);

  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (sessionLoading) return;
    setOverrides(readExpanded(userId));
  }, [sessionLoading, userId]);

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
        });
      // Dedupe BEFORE capping: upstream duplicates collapsed in the DOM (React
      // keys) while still counting toward "Show N more" (release-audit bug).
      setProjects(dedupeProjectRepos(repos).slice(0, MAX_PROJECTS));
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
      writeExpanded(userId, next);
      return next;
    });
  };

  // Fold a data group into the native tree view model: a title, the clean repo
  // name for the actions menu, and each thread's label + real relative-time chip
  // + active-state from the current route.
  const toTree = useCallback(
    (list: readonly ProjectGroup[]): TreeProjectGroup[] =>
      list.map((group) => ({
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
    [pathname],
  );

  // Projects with active threads stay in view; the long tail of empty repos sits
  // behind "Show N more" (they were flooding the rail); loose threads with no
  // project get their own bottom section with its own "Show N more".
  const activeProjects = useMemo(
    () => groups.filter((group) => group.fullName !== null && group.threads.length > 0),
    [groups],
  );
  const emptyProjects = useMemo(
    () => groups.filter((group) => group.fullName !== null && group.threads.length === 0),
    [groups],
  );
  const independentThreads = useMemo(
    () => groups.find((group) => group.key === UNATTACHED_KEY)?.threads ?? [],
    [groups],
  );

  const renderMenu = useCallback(
    (group: TreeProjectGroup, control: ProjectMenuControl) =>
      group.fullName ? (
        <SidebarProjectMenu group={group} isOpen={control.isOpen} setOpen={control.setOpen} />
      ) : null,
    [],
  );

  if (groups.length === 0) return null;

  const visibleThreads = showAllThreads
    ? independentThreads
    : independentThreads.slice(0, VISIBLE_THREADS);
  const threadOverflow = independentThreads.length - visibleThreads.length;

  return (
    <>
      {activeProjects.length > 0 && (
        <>
          <SidebarSectionLabel>Projects</SidebarSectionLabel>
          <ProjectThreadTree
            groups={toTree(activeProjects)}
            isExpanded={isExpanded}
            onToggle={toggle}
            threadHref={(thread) => `/session/${thread.id}`}
            renderMenu={renderMenu}
          />
        </>
      )}

      {emptyProjects.length > 0 && (
        <>
          {showEmptyProjects && (
            <ProjectThreadTree
              groups={toTree(emptyProjects)}
              isExpanded={isExpanded}
              onToggle={toggle}
              threadHref={(thread) => `/session/${thread.id}`}
              renderMenu={renderMenu}
            />
          )}
          <button
            type="button"
            onClick={() => setShowEmptyProjects((value) => !value)}
            className="flex w-full items-center gap-1 rounded-lg px-2.5 py-1 text-caption-1-regular text-text-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-secondary"
          >
            {showEmptyProjects ? "Show fewer" : `Show ${emptyProjects.length} more`}
          </button>
        </>
      )}

      {independentThreads.length > 0 && (
        <>
          <SidebarSectionLabel>Threads</SidebarSectionLabel>
          <ul aria-label="Threads without a project" className="flex flex-col">
            {visibleThreads.map((run) => {
              const href = `/session/${run.id}`;
              return (
                <li key={run.id}>
                  <ThreadRow run={run} href={href} active={pathname === href} />
                </li>
              );
            })}
            {threadOverflow > 0 || showAllThreads ? (
              <li>
                <button
                  type="button"
                  onClick={() => setShowAllThreads((value) => !value)}
                  className="flex w-full items-center gap-1 rounded-lg px-2.5 py-1 text-caption-1-regular text-text-tertiary transition-colors hover:bg-background-secondary-hover hover:text-text-secondary"
                >
                  {showAllThreads ? "Show fewer" : `Show ${threadOverflow} more`}
                </button>
              </li>
            ) : null}
          </ul>
        </>
      )}
    </>
  );
}
