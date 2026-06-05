/**
 * Pure grouping logic for the project-nested thread rail. Takes the two existing
 * sidebar data lanes - the runs summary (threads) and GET /api/repos (the full
 * project list) - and folds them into ordered project groups, each carrying its
 * own threads nested beneath it. No React, no fetching: isomorphic and testable.
 *
 * A thread belongs to the project of its PRIMARY repo (repo_specs > repos >
 * legacy repo). Threads with no repo collect in a single "No project" bucket.
 * Every repo from /api/repos is represented even when it carries zero threads,
 * so the user can still open one to start a thread there.
 */

import { repoShortname } from "@/components/session-ui/git-chip";
import { threadRowTimestamp } from "@/components/session-ui/thread-row";
import { primaryRepo } from "@/lib/runs";
import type { SidebarRun } from "./working-project-status";

export interface ProjectRepo {
  readonly fullName: string;
  readonly name: string;
}

export interface ProjectGroup {
  /** Stable key: the repo full_name, or UNATTACHED_KEY for the no-repo bucket. */
  readonly key: string;
  /** Display name: the /api/repos name, the repo short name, or "No project". */
  readonly name: string;
  /** Clean "owner/name" for a real repo; null for the unattached bucket. */
  readonly fullName: string | null;
  /** Threads whose primary repo is this project, newest activity first. */
  readonly threads: readonly SidebarRun[];
}

/** Bucket key for threads that carry no repo. */
export const UNATTACHED_KEY = "__unattached__";

/** Primary repo of a typed run summary (repo_specs > repos > legacy repo).
 *  A typed adapter over the shared `primaryRepo`, which reads the same fields
 *  off a raw wire row. */
export function runPrimaryRepo(run: SidebarRun): string | null {
  return primaryRepo(run as unknown as Record<string, unknown>);
}

function recency(run: SidebarRun): number {
  return threadRowTimestamp(run) ?? 0;
}

/**
 * Fold threads + repos into ordered project groups. Order:
 *   1. Projects that have threads, most-recent thread first.
 *   2. The "No project" bucket, when any thread lacks a repo.
 *   3. Projects with zero threads (from /api/repos), alphabetical.
 * Threads inside each group are sorted newest activity first.
 */
export function groupThreadsByProject(
  runs: readonly SidebarRun[],
  repos: readonly ProjectRepo[],
): ProjectGroup[] {
  const threadsByRepo = new Map<string, SidebarRun[]>();
  const unattached: SidebarRun[] = [];
  for (const run of runs) {
    const key = runPrimaryRepo(run);
    if (key === null) {
      unattached.push(run);
      continue;
    }
    const bucket = threadsByRepo.get(key);
    if (bucket) bucket.push(run);
    else threadsByRepo.set(key, [run]);
  }

  // Names come from /api/repos when known; a repo referenced only by a thread
  // still gets a group, named from its "owner/name" short form.
  const repoName = new Map(repos.map((repo) => [repo.fullName, repo.name] as const));
  const repoKeys = new Set<string>([...repoName.keys(), ...threadsByRepo.keys()]);

  const groups: ProjectGroup[] = [];
  for (const key of repoKeys) {
    const threads = (threadsByRepo.get(key) ?? []).toSorted((a, b) => recency(b) - recency(a));
    groups.push({
      key,
      name: repoName.get(key) ?? repoShortname(key),
      fullName: key,
      threads,
    });
  }

  const withThreads = groups
    .filter((group) => group.threads.length > 0)
    .toSorted((a, b) => {
      const byRecency = recency(b.threads[0]) - recency(a.threads[0]);
      return byRecency !== 0 ? byRecency : a.name.localeCompare(b.name);
    });
  const zeroThreads = groups
    .filter((group) => group.threads.length === 0)
    .toSorted((a, b) => a.name.localeCompare(b.name));

  const ordered = [...withThreads];
  if (unattached.length > 0) {
    ordered.push({
      key: UNATTACHED_KEY,
      name: "No project",
      fullName: null,
      threads: unattached.toSorted((a, b) => recency(b) - recency(a)),
    });
  }
  ordered.push(...zeroThreads);
  return ordered;
}

/** Dedupe repos on fullName, first occurrence wins. The sidebar renders rows
 *  keyed by fullName, so upstream duplicates collapsed in the DOM while still
 *  counting toward the "Show N more" toggle - the count overstated the list
 *  and rows looked missing. Dedupe BEFORE any visible/overflow split. */
export function dedupeProjectRepos(repos: readonly ProjectRepo[]): ProjectRepo[] {
  const seen = new Set<string>();
  return repos.filter((repo) => (seen.has(repo.fullName) ? false : (seen.add(repo.fullName), true)));
}

export interface VisibleProjectGroups {
  readonly groups: readonly ProjectGroup[];
  readonly hiddenCount: number;
}

/** Keep a useful project sample visible before the user expands the long tail. */
export function visibleProjectGroups(
  groups: readonly ProjectGroup[],
  limit: number,
  expanded: boolean,
): VisibleProjectGroups {
  if (expanded) return { groups, hiddenCount: 0 };
  const visible = groups.slice(0, Math.max(0, limit));
  return { groups: visible, hiddenCount: groups.length - visible.length };
}
