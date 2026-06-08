export const EXECUTION_GRAPH_ROLLOUT_MODES = ["off", "shadow", "read"] as const;
export type ExecutionGraphRolloutMode = (typeof EXECUTION_GRAPH_ROLLOUT_MODES)[number];

export function executionGraphRolloutMode(
  env: Record<string, string | undefined> = process.env,
): ExecutionGraphRolloutMode {
  const value = env.EXECUTION_GRAPH_ROLLOUT?.trim().toLowerCase();
  return value === "shadow" || value === "read" ? value : "off";
}

export function executionGraphReadEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return executionGraphRolloutMode(env) === "read";
}

export function executionGraphWriteEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return executionGraphRolloutMode(env) !== "off";
}
