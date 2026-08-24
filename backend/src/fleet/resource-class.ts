import type { FleetCapacityConfig } from "../env";
import type { WorkloadTier } from "../db/schema/fleet";

// ---------------------------------------------------------------------------
// Resource class resolution — map an accepted run to its declared sandbox
// resource class (tier + cpu/memory). Stage A places every run in the
// `standard` tier; the `desktop` tier + its plumbing exist for when a run
// declares a desktop/VNC need (no ingress does yet), so the reservation math and
// the config are already tier-aware without inventing an unused signal.
// ---------------------------------------------------------------------------

export interface ResolvedResourceClass {
  readonly tier: WorkloadTier;
  readonly cpuMillicores: number;
  readonly memoryMib: number;
}

export function resourceClassForRun(
  _run: { readonly engine: string; readonly model: string },
  config: FleetCapacityConfig,
): ResolvedResourceClass {
  const tier: WorkloadTier = "standard";
  const spec = config.tiers[tier];
  return {
    tier,
    cpuMillicores: spec.cpuMillicores,
    memoryMib: spec.memoryMib,
  };
}
