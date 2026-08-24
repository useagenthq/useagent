import type { FleetCapacityConfig } from "../env";
import type {
  AdmissionDecision,
  AdmissionRequest,
  CapacityInventory,
} from "./types";

// ---------------------------------------------------------------------------
// CapacityPolicy — the single provider-neutral admission decision. Pure: same
// inputs always yield the same decision, so every branch is unit-tested without
// a database or a live provider.
//
// Reservation model: capacity is reserved against DECLARED host resources with a
// configurable safety margin, NOT against currently-resident RAM. The margin
// leaves headroom for the OS, the warm pool, and provider overhead so the host
// is never oversubscribed on paper.
//
//   effective host = declared host * (1 - safetyMarginPct/100)
//
// Decision order (first failing gate wins): invalid request -> global sandbox
// count -> per-org sandbox count -> declared-resource reservation -> optional
// provider allocatable ceiling. This ordering surfaces the most actionable
// reason (a per-org limit is more actionable to a tenant than a host-wide one).
// ---------------------------------------------------------------------------

function admit(): AdmissionDecision {
  return { decision: "admit", reason: "capacity available" };
}

export function evaluateAdmission(
  request: AdmissionRequest,
  inventory: CapacityInventory,
  config: FleetCapacityConfig,
): AdmissionDecision {
  const tier = config.tiers[request.tier];
  const marginFactor = 1 - config.safetyMarginPct / 100;
  const effectiveHostCpu = Math.floor(config.hostCpuMillicores * marginFactor);
  const effectiveHostMem = Math.floor(config.hostMemoryMib * marginFactor);

  // 1. Invalid request — unknown tier, non-positive ask, or an ask that could
  //    never fit the margined host (it would queue forever). Reject, don't queue.
  if (!tier) {
    return {
      decision: "reject_invalid_request",
      reason: `unknown workload tier: ${request.tier}`,
    };
  }
  if (request.cpuMillicores <= 0 || request.memoryMib <= 0) {
    return {
      decision: "reject_invalid_request",
      reason: "cpu and memory must be positive",
    };
  }
  if (
    request.cpuMillicores > effectiveHostCpu ||
    request.memoryMib > effectiveHostMem
  ) {
    return {
      decision: "reject_invalid_request",
      reason: "request exceeds the host capacity budget and can never be admitted",
    };
  }

  // 2. Global active-sandbox count.
  if (inventory.globalActiveSandboxes + 1 > config.globalMaxActiveSandboxes) {
    return {
      decision: "queue_global_limit",
      reason: `global active sandbox limit reached (${inventory.globalActiveSandboxes}/${config.globalMaxActiveSandboxes})`,
    };
  }

  // 3. Per-org active-sandbox count.
  if (inventory.orgActiveSandboxes + 1 > config.orgMaxActiveSandboxes) {
    return {
      decision: "queue_org_limit",
      reason: `org active sandbox limit reached (${inventory.orgActiveSandboxes}/${config.orgMaxActiveSandboxes})`,
    };
  }

  // 4. Declared-resource reservation against the margined host budget.
  if (
    inventory.globalReservedCpuMillicores + request.cpuMillicores >
      effectiveHostCpu ||
    inventory.globalReservedMemoryMib + request.memoryMib > effectiveHostMem
  ) {
    return {
      decision: "queue_provider_capacity",
      reason: "declared cpu/memory reservation would exceed the host budget",
    };
  }

  // 5. Optional provider allocatable ceiling (multi-node Cube inventory). Absent
  //    ceilings are skipped; the declared-host budget governed above.
  if (inventory.providerNodes) {
    const fits = inventory.providerNodes.some((node) =>
      node.ready &&
      !node.schedulingDisabled &&
      request.cpuMillicores <= node.allocatableCpuMillicores &&
      request.memoryMib <= node.allocatableMemoryMib
    );
    if (!fits) {
      return {
        decision: "queue_provider_capacity",
        reason: "no ready provider node can fit the complete resource request",
      };
    }
  } else if (
    inventory.providerAllocatableCpuMillicores !== undefined &&
    request.cpuMillicores > inventory.providerAllocatableCpuMillicores
  ) {
    return {
      decision: "queue_provider_capacity",
      reason: "no provider node has enough allocatable cpu",
    };
  }
  if (
    inventory.providerNodes === undefined &&
    inventory.providerAllocatableMemoryMib !== undefined &&
    request.memoryMib > inventory.providerAllocatableMemoryMib
  ) {
    return {
      decision: "queue_provider_capacity",
      reason: "no provider node has enough allocatable memory",
    };
  }

  return admit();
}
