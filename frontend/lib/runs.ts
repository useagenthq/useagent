/**
 * Shared run-domain primitives — the run lifecycle status plus the list-envelope
 * normalization used across the dashboard, workspace fleet, runs list and the
 * chat session surface. Pure and isomorphic (no React, no "use client"), so it
 * is safe to import from both server pages and client views.
 */

// The run lifecycle status is the agent-client wire contract; re-exported here so
// the dashboard/fleet/runs-list/session surfaces keep one import path alongside
// the list-envelope + primary-repo helpers below.
import { RUN_STATUSES, type RunStatus } from "@useagent/agent-client/wire";
export type { RunStatus };

const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUSES);

/** Narrow an arbitrary value to a RunStatus. Malformed rows are dropped by callers. */
export function toRunStatus(value: unknown): RunStatus | null {
  return typeof value === "string" && RUN_STATUS_SET.has(value) ? (value as RunStatus) : null;
}

/**
 * Unwrap a backend list envelope. The list endpoints ship `{ [key]: [...] }`
 * (e.g. `{ runs: [...] }`); a bare array is tolerated too. Anything else → [].
 */
export function envelope(data: unknown, key: string): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const inner = (data as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

/**
 * Primary repository of a raw wire run: `repo_specs` is authoritative,
 * followed by the legacy plural and singular fields.
 */
export function primaryRepo(run: Record<string, unknown>): string | null {
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
