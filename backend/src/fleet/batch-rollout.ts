export type FleetBatchRolloutMode = "off" | "read" | "write";

export function fleetBatchRolloutMode(
  env: Record<string, string | undefined> = process.env,
): FleetBatchRolloutMode {
  const value = env.FLEET_BATCH_ROLLOUT?.trim().toLowerCase();
  return value === "read" || value === "write" ? value : "off";
}

export function fleetBatchReadEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return fleetBatchRolloutMode(env) !== "off";
}

export function fleetBatchWriteEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return fleetBatchRolloutMode(env) === "write";
}
