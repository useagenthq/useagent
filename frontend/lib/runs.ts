/**
 * Shared run-domain primitives — the run lifecycle status plus the list-envelope
 * normalization used across the dashboard, workspace fleet, runs list and the
 * chat session surface. Pure and isomorphic (no React, no "use client"), so it
 * is safe to import from both server pages and client views.
 */

export type RunStatus = "queued" | "running" | "completed" | "failed";

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "completed",
  "failed",
]);

/** Narrow an arbitrary value to a RunStatus, defaulting to "queued". */
export function toRunStatus(value: unknown): RunStatus {
  return RUN_STATUSES.has(value as string) ? (value as RunStatus) : "queued";
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
