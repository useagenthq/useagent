/**
 * Pure helpers + types for the fleet-by-project overview (the lane grouping). No
 * React, no "use client" — safe to import from a server page (SSR fetch) and any
 * client view alike, so the lane math stays identical on both sides.
 */

import { envelope, type RunStatus, toRunStatus } from "@/lib/runs";

/** The slim run shape the fleet lanes need — steps/trace are irrelevant here. */
export interface WorkspaceRun {
  id: string;
  prompt: string;
  model: string | null;
  /** Primary repository for this run, using the authoritative wire fallback order. */
  repo: string | null;
  status: RunStatus;
  duration_ms: number | null;
  created_at: string | number;
}

/** The list endpoint may return a bare array or a `{ runs: [...] }` envelope
 * (what the backend actually ships). Accept both, then normalise. */
export function extractRuns(data: unknown): WorkspaceRun[] {
  return envelope(data, "runs")
    .map(toWorkspaceRun)
    .filter((r): r is WorkspaceRun => r !== null);
}

function toWorkspaceRun(value: unknown): WorkspaceRun | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  return {
    id: r.id,
    prompt: typeof r.prompt === "string" ? r.prompt : "",
    model: typeof r.model === "string" ? r.model : null,
    repo: primaryRepo(r),
    status: toRunStatus(r.status),
    duration_ms: typeof r.duration_ms === "number" ? r.duration_ms : null,
    created_at: (r.created_at as string | number) ?? 0,
  };
}

/** `repo_specs` is authoritative, followed by the legacy plural and singular fields. */
function primaryRepo(run: Record<string, unknown>): string | null {
  if (Array.isArray(run.repo_specs)) {
    for (const spec of run.repo_specs) {
      if (!spec || typeof spec !== "object") continue;
      const repo = (spec as { repo?: unknown }).repo;
      if (typeof repo === "string" && repo.length > 0) return repo;
    }
  }
  if (Array.isArray(run.repos)) {
    for (const repo of run.repos) {
      if (typeof repo === "string" && repo.length > 0) return repo;
    }
  }
  return typeof run.repo === "string" && run.repo.length > 0 ? run.repo : null;
}

export interface FleetStats {
  working: number;
  queued: number;
  completed: number;
  failed: number;
  total: number;
}

export function computeStats(runs: readonly WorkspaceRun[]): FleetStats {
  const stats: FleetStats = { working: 0, queued: 0, completed: 0, failed: 0, total: runs.length };
  for (const run of runs) {
    if (run.status === "running") stats.working += 1;
    else if (run.status === "queued") stats.queued += 1;
    else if (run.status === "completed") stats.completed += 1;
    else if (run.status === "failed") stats.failed += 1;
  }
  return stats;
}

export interface LaneGroup {
  /** Full owner/name identity; also the stable React key. */
  name: string;
  /** Compact project label shown in the dashboard. */
  label: string;
  runs: WorkspaceRun[];
  working: number;
}

/** Group repository-backed runs by their primary repository, newest-first. */
export function groupIntoLanes(runs: readonly WorkspaceRun[]): LaneGroup[] {
  const byRepo = new Map<string, WorkspaceRun[]>();
  for (const run of runs) {
    if (!run.repo) continue;
    const repoRuns = byRepo.get(run.repo) ?? [];
    repoRuns.push(run);
    byRepo.set(run.repo, repoRuns);
  }

  return [...byRepo.entries()]
    .map(([name, repoRuns]) => {
      const laneRuns = repoRuns.toSorted(
        (a, b) => timestamp(b.created_at) - timestamp(a.created_at),
      );
      return {
        name,
        label: repoShortname(name),
        runs: laneRuns,
        working: laneRuns.filter((r) => r.status === "running").length,
      };
    })
    .toSorted(
      (a, b) => timestamp(b.runs[0]?.created_at ?? 0) - timestamp(a.runs[0]?.created_at ?? 0),
    );
}

function repoShortname(repo: string): string {
  const slash = repo.lastIndexOf("/");
  return slash === -1 ? repo : repo.slice(slash + 1);
}

function timestamp(value: string | number): number {
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}
