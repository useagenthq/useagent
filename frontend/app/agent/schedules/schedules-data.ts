import type { DotTone } from "@/components/shared/status-dot";

/**
 * Domain types + helpers for the Schedules surface. Pure and isomorphic (no
 * React, no "use client") so both the server page and the client view can
 * import it. Fetching lives in `schedules-api.ts`.
 */

/** Engines a schedule can run under — the real backend adapters, no `mock`. */
export const SCHEDULE_ENGINES = [
  "codex",
  "opencode",
  "claude-sdk",
  "daytona",
] as const;
export type ScheduleEngine = (typeof SCHEDULE_ENGINES)[number];

/** Display label for an engine id (tolerates ids outside the create list). */
export const ENGINE_LABEL: Record<string, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  "claude-sdk": "Claude SDK",
  daytona: "Daytona",
  mock: "Mock",
  acp: "ACP",
};

export function engineLabel(engine: string): string {
  return ENGINE_LABEL[engine] ?? engine;
}

/** Wire shape from `GET /api/schedules` (snake_case, per the backend contract). */
export interface ScheduleRecord {
  id: string;
  org_id: string;
  user_id: string | null;
  name: string;
  cron: string;
  prompt: string;
  engine: string;
  model: string;
  enabled: boolean;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Wire shape from `GET /api/schedules/:id/history`. */
export interface FiringRecord {
  id: string;
  schedule_id: string;
  run_id: string;
  fired_at: string;
  trigger: "cron" | "manual";
  /** Firing-time snapshot ("queued"). */
  status: string;
  /** Live run status, joined from the runs log; null if the run is gone. */
  run_status: string | null;
  run_summary: string | null;
}

/** Map a run status to a status-dot tone. */
export function runTone(status: string | null): DotTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "running":
      return "info";
    case "queued":
      return "away";
    default:
      return "neutral";
  }
}
