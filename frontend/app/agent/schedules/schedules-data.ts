import { ENGINES } from "@/components/chat/types";
import type { DotTone } from "@/components/shared/status-dot";

/**
 * Domain types + helpers for the Automations surface. Pure and isomorphic (no
 * React, no "use client") so both the server page and the client view can
 * import it. Fetching lives in `schedules-api.ts`.
 */

/** Legacy display metadata only. These ids must never become picker options. */
const LEGACY_ENGINE_LABEL: Record<string, string> = {
  "claude-sdk": "Claude SDK",
  daytona: "Daytona",
  mock: "Mock",
  acp: "ACP",
};

export function engineLabel(engine: string): string {
  return ENGINES.find(({ id }) => id === engine)?.label ?? LEGACY_ENGINE_LABEL[engine] ?? engine;
}

export interface AutomationEngineOption {
  id: string;
  label: string;
}

/** Project the server-enabled ids through chat's current engine catalog. */
export function automationEngineOptions(
  enabledEngines: readonly string[],
): AutomationEngineOption[] {
  return ENGINES.filter(({ id }) => enabledEngines.includes(id)).map(({ id, label }) => ({
    id,
    label,
  }));
}

/** Keep a disabled draft's stored engine visible while editing it. The engine
 * remains unavailable for new automations and cannot run until connected. */
export function automationEditorEngineOptions(
  enabledEngines: readonly string[],
  storedEngine?: string,
): AutomationEngineOption[] {
  const options = automationEngineOptions(enabledEngines);
  if (!storedEngine || options.some(({ id }) => id === storedEngine)) return options;
  return [{ id: storedEngine, label: `${engineLabel(storedEngine)} (unavailable)` }, ...options];
}

/** Keep a new draft on a live option as server capabilities resolve or change. */
export function reconcileAutomationEngine(
  options: readonly AutomationEngineOption[],
  current: string,
): string {
  return options.some(({ id }) => id === current) ? current : (options[0]?.id ?? "");
}

/** Wire shape from `GET /api/automations` (snake_case, per the backend contract). */
export interface ScheduleRecord {
  id: string;
  org_id: string;
  user_id: string | null;
  name: string;
  cron: string;
  timezone: string | null;
  prompt: string;
  engine: string;
  model: string;
  skill_id: string | null;
  skill_version: number | null;
  skill_content_hash: string | null;
  repos: string[];
  tags: string[];
  delivery: Record<string, unknown> | null;
  notifications: Record<string, unknown> | null;
  run_actor_id: string | null;
  concurrency: Record<string, unknown> | null;
  queue: Record<string, unknown> | null;
  cost_limits: Record<string, unknown> | null;
  frequency_limits: Record<string, unknown> | null;
  approval_policy: Record<string, unknown> | null;
  enablement_policy: Record<string, unknown> | null;
  enabled: boolean;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function clockLabel(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/**
 * Explain the common cadences offered by the editor. Unknown expressions stay
 * explicit rather than receiving a misleading best-effort interpretation.
 */
export function cadenceLabel(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minuteField, hourField, day, month, weekday] = fields;
  if (day !== "*" || month !== "*") return cron;

  if (hourField === "*" && minuteField === "0" && weekday === "*") {
    return "Every hour";
  }
  const minuteInterval = minuteField?.match(/^\*\/(\d+)$/)?.[1];
  if (hourField === "*" && minuteInterval && weekday === "*") {
    return `Every ${minuteInterval} minutes`;
  }

  const minute = Number(minuteField);
  const hour = Number(hourField);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return cron;
  const time = clockLabel(hour, minute);
  if (weekday === "*") return `Every day at ${time}`;
  if (weekday === "1-5") return `Weekdays at ${time}`;
  const weekdayName = WEEKDAY_NAMES[Number(weekday)];
  return weekdayName ? `Every ${weekdayName} at ${time}` : cron;
}

export function scheduleZone(schedule: Pick<ScheduleRecord, "timezone">): string {
  return schedule.timezone ?? "Server timezone";
}

/** Wire shape from `GET /api/automations/:id/history`. */
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
