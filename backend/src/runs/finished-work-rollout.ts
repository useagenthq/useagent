export const FINISHED_WORK_ROLLOUT_MODES = ["off", "shadow", "enforce"] as const;
export type FinishedWorkRolloutMode = (typeof FINISHED_WORK_ROLLOUT_MODES)[number];

export function finishedWorkRolloutMode(
  env: Record<string, string | undefined> = process.env,
): FinishedWorkRolloutMode {
  const value = env.FINISHED_WORK_ROLLOUT?.trim().toLowerCase();
  return value === "shadow" || value === "enforce" ? value : "off";
}

function allowlist(value: string | undefined, normalize: (value: string) => string): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => normalize(entry.trim()))
      .filter(Boolean),
  );
}

/** Enforcement may be narrowed by engine and exact run-id canaries. An empty
 * list means no narrowing; rollout=enforce remains the explicit activation. */
export function finishedWorkEnforcementEnabled(
  engine: string,
  runId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (finishedWorkRolloutMode(env) !== "enforce") return false;
  const engines = allowlist(env.FINISHED_WORK_ENFORCE_ENGINES, (value) => value.toLowerCase());
  if (engines.size > 0 && !engines.has(engine.trim().toLowerCase())) return false;
  const canaryRuns = allowlist(env.FINISHED_WORK_ENFORCE_RUN_IDS, (value) => value);
  return canaryRuns.size === 0 || canaryRuns.has(runId.trim());
}
