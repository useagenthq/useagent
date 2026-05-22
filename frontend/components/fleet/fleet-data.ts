/**
 * Types + defensive normalizer for the fleet "Limits" card, fed by the real
 * backend GET /api/fleet. No React, no "use client" — pure so it can be shared
 * and unit-reasoned. Everything here reflects live data (the runs +
 * provider_events log and the Daytona control plane); nothing is fabricated.
 */

/** One model's real usage today. `tokens`/`cost` are 0 for engines that don't
 *  emit usage (only opencode's step-finish carries it) — an honest zero. */
export interface ModelBurn {
  model: string;
  runs: number;
  completed: number;
  avgMs: number | null;
  tokens: number;
  cost: number;
}

/** The org's live Daytona footprint. `sandboxes` is null while the backend's
 *  inventory cache is still warming (or Daytona is unconfigured). */
export interface MachineStats {
  snapshot: string;
  sandboxes: { active: number; idle: number; liveThreads: number } | null;
}

export interface FleetData {
  models: ModelBurn[];
  totalTokens: number;
  totalCost: number;
  totalRuns: number;
  machine: MachineStats | null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toModelBurn(value: unknown): ModelBurn | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (typeof m.model !== "string") return null;
  return {
    model: m.model,
    runs: num(m.runs),
    completed: num(m.completed),
    avgMs: typeof m.avgMs === "number" && Number.isFinite(m.avgMs) ? m.avgMs : null,
    tokens: num(m.tokens),
    cost: num(m.cost),
  };
}

function toMachine(value: unknown): MachineStats | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (typeof m.snapshot !== "string") return null;
  const s = m.sandboxes;
  const sandboxes =
    s && typeof s === "object"
      ? {
          active: num((s as Record<string, unknown>).active),
          idle: num((s as Record<string, unknown>).idle),
          liveThreads: num((s as Record<string, unknown>).liveThreads),
        }
      : null;
  return { snapshot: m.snapshot, sandboxes };
}

/** Normalize a GET /api/fleet response; returns null when the shape is unusable
 *  (a transient/failed fetch), so callers keep their last good snapshot. */
export function extractFleet(data: unknown): FleetData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.models)) return null;
  return {
    models: d.models.map(toModelBurn).filter((m): m is ModelBurn => m !== null),
    totalTokens: num(d.totalTokens),
    totalCost: num(d.totalCost),
    totalRuns: num(d.totalRuns),
    machine: toMachine(d.machine),
  };
}
