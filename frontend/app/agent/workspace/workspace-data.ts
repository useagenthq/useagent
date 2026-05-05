/**
 * Pure helpers + types for the /agent/workspace fleet overview. No React, no
 * "use client" — safe to import from both the server page (SSR fetch) and the
 * client view (15s refresh), so the banner math stays identical on both sides.
 */

import { envelope, toRunStatus, type RunStatus } from "@/lib/runs";

/** The slim run shape the workspace needs — steps/trace are irrelevant here. */
export interface WorkspaceRun {
  id: string;
  prompt: string;
  model: string | null;
  status: RunStatus;
  duration_ms: number | null;
  created_at: string | number;
}

/** The four workstreams runs are round-robined into (mirrors AgentSidebar). */
export const LANES = [
  "Growth Operator",
  "Content Pipeline",
  "Workflow Engine",
  "Research Cluster",
] as const;

export type Lane = (typeof LANES)[number];

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
    status: toRunStatus(r.status),
    duration_ms: typeof r.duration_ms === "number" ? r.duration_ms : null,
    created_at: (r.created_at as string | number) ?? 0,
  };
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

/** Deterministic FNV-ish hash so a run always lands in the same lane. */
function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export function laneForRun(run: WorkspaceRun): Lane {
  return LANES[hashId(run.id) % LANES.length];
}

export interface LaneGroup {
  name: Lane;
  runs: WorkspaceRun[];
  working: number;
}

/** Group runs into the four lanes, newest-first within each lane. */
export function groupIntoLanes(runs: readonly WorkspaceRun[]): LaneGroup[] {
  const byLane = new Map<Lane, WorkspaceRun[]>(LANES.map((name) => [name, []]));
  for (const run of runs) byLane.get(laneForRun(run))!.push(run);
  return LANES.map((name) => {
    const laneRuns = byLane
      .get(name)!
      .toSorted((a, b) => timestamp(b.created_at) - timestamp(a.created_at));
    return {
      name,
      runs: laneRuns,
      working: laneRuns.filter((r) => r.status === "running").length,
    };
  });
}

function timestamp(value: string | number): number {
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}
