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
import { primaryRepo } from "@/lib/runs";
import { rankThreads, threadActivityTimestamp } from "./thread-discovery";
import type { SidebarRun } from "./working-project-status";
import type {
  ProductThreadStatus,
  ThreadRelationship,
} from "@useagent/agent-client";
import type { EngineId } from "@useagent/agent-client/wire";

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

export interface SidebarThreadFamilyNode {
  readonly id: string;
  readonly title: string;
  readonly status: ProductThreadStatus;
  readonly engine: EngineId;
  readonly model: string;
  readonly activityAt: string;
  readonly run: SidebarRun | null;
  readonly relationship: ThreadRelationship;
  readonly children: readonly SidebarThreadFamilyNode[];
}

const relationshipPriority = (status: ProductThreadStatus): number => {
  if (status === "running") return 0;
  if (status === "waiting" || status === "queued") return 1;
  return 2;
};

function compareFamilyNodes(a: SidebarThreadFamilyNode, b: SidebarThreadFamilyNode): number {
  const status = relationshipPriority(a.status) - relationshipPriority(b.status);
  if (status !== 0) return status;
  const activity = Date.parse(b.activityAt) - Date.parse(a.activityAt);
  return activity !== 0 ? activity : a.id.localeCompare(b.id);
}

/** Build the ordinary product-thread hierarchy without hydrating any transcript. */
export function projectSidebarThreadFamilies(
  runs: readonly SidebarRun[],
  relationships: readonly ThreadRelationship[],
): {
  readonly roots: readonly SidebarRun[];
  readonly byRoot: ReadonlyMap<string, readonly SidebarThreadFamilyNode[]>;
} {
  const runsById = new Map(runs.map((run) => [run.id, run] as const));
  const relationshipById = new Map(relationships.map((item) => [item.threadId, item] as const));
  const childIds = new Set(
    relationships.flatMap((item) => item.parentThreadId ? [item.threadId] : []),
  );
  const roots = rankThreads(runs.filter((run) => !childIds.has(run.id)).map((run) => {
    const relationship = relationshipById.get(run.id);
    if (!relationship) return run;
    const status = relationship.status === "waiting"
      ? "queued"
      : relationship.status === "cancelled"
        ? "completed"
        : relationship.status;
    return {
      ...run,
      prompt: relationship.title,
      status,
      latest_status: status,
      latest_run_id: relationship.latestRunId,
      latest_updated_at: relationship.latestActivityAt,
    } satisfies SidebarRun;
  }));
  const childrenByParent = new Map<string, ThreadRelationship[]>();
  for (const item of relationships) {
    if (!item.parentThreadId) continue;
    const children = childrenByParent.get(item.parentThreadId) ?? [];
    children.push(item);
    childrenByParent.set(item.parentThreadId, children);
  }
  const build = (item: ThreadRelationship, path: ReadonlySet<string>): SidebarThreadFamilyNode => {
    const nextPath = new Set(path).add(item.threadId);
    const children = (childrenByParent.get(item.threadId) ?? [])
      .filter((child) => !nextPath.has(child.threadId))
      .map((child) => build(child, nextPath))
      .toSorted(compareFamilyNodes);
    return {
      id: item.threadId,
      title: item.title,
      status: item.status,
      engine: item.engine,
      model: item.model,
      activityAt: item.latestActivityAt,
      run: runsById.get(item.threadId) ?? null,
      relationship: item,
      children,
    };
  };
  const byRoot = new Map<string, readonly SidebarThreadFamilyNode[]>();
  for (const root of roots) {
    const rootRelationship = relationshipById.get(root.id);
    const familyId = rootRelationship?.familyThreadId ?? root.id;
    const direct = relationships
      .filter((item) => item.familyThreadId === familyId && item.parentThreadId === root.id)
      .map((item) => build(item, new Set([root.id])))
      .toSorted(compareFamilyNodes);
    if (direct.length > 0) byRoot.set(root.id, direct);
  }
  return { roots, byRoot };
}

/** Primary repo of a typed run summary (repo_specs > repos > legacy repo).
 *  A typed adapter over the shared `primaryRepo`, which reads the same fields
 *  off a raw wire row. */
export function runPrimaryRepo(run: SidebarRun): string | null {
  return primaryRepo(run as unknown as Record<string, unknown>);
}

function recency(run: SidebarRun): number {
  return threadActivityTimestamp(run) ?? 0;
}

function groupRecency(group: ProjectGroup): number {
  let latest = 0;
  for (const run of group.threads) latest = Math.max(latest, recency(run));
  return latest;
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
  for (const run of rankThreads(runs)) {
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
    const threads = rankThreads(threadsByRepo.get(key) ?? []);
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
      const byRecency = groupRecency(b) - groupRecency(a);
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
      threads: rankThreads(unattached),
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
  return repos.filter((repo) => {
    if (seen.has(repo.fullName)) return false;
    seen.add(repo.fullName);
    return true;
  });
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
