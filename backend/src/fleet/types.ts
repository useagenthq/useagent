import type { QueueReason, WorkloadTier } from "../db/schema/fleet";

// ---------------------------------------------------------------------------
// Provider-neutral capacity types (HA Stage A). The CapacityPolicy is a PURE
// function: it maps a resource request + an inventory snapshot to a decision,
// with no DB or provider IO. That keeps admission logic fully unit-testable and
// identical across providers (Cube, Daytona, the test double).
// ---------------------------------------------------------------------------

/** One run's declared resource ask. cpu is millicores (2000 = 2 vCPU); memory is
 *  MiB. These are DECLARED sandbox resources, never measured RAM. */
export interface AdmissionRequest {
  readonly orgId: string;
  readonly engine: string;
  readonly model: string;
  readonly tier: WorkloadTier;
  readonly cpuMillicores: number;
  readonly memoryMib: number;
}

/** A point-in-time capacity snapshot. The global/org counts + reservations come
 *  from the durable sandbox_leases table; the optional provider ceilings come
 *  from the sandbox contract's inventory method (multi-node Cube). */
export interface CapacityInventory {
  readonly globalActiveSandboxes: number;
  readonly globalReservedCpuMillicores: number;
  readonly globalReservedMemoryMib: number;
  readonly orgActiveSandboxes: number;
  /** Provider-reported allocatable ceilings; absent when the provider does not
   *  implement inventory (then the declared-host budget governs alone). */
  readonly providerAllocatableCpuMillicores?: number;
  readonly providerAllocatableMemoryMib?: number;
  readonly providerReadyNodes?: number;
}

export type AdmissionDecisionKind =
  | "admit"
  | "queue_global_limit"
  | "queue_org_limit"
  | "queue_provider_capacity"
  | "reject_invalid_request";

export interface AdmissionDecision {
  readonly decision: AdmissionDecisionKind;
  /** Human-readable explanation (for logs + the queued run's queue_reason UI). */
  readonly reason: string;
}

/** Map a non-admit decision to the durable queue_reason enum. Returns null for
 *  `admit` (no reason persisted). */
export function queueReasonForDecision(
  kind: AdmissionDecisionKind,
): QueueReason | null {
  switch (kind) {
    case "admit":
      return null;
    case "queue_global_limit":
      return "global_limit";
    case "queue_org_limit":
      return "org_limit";
    case "queue_provider_capacity":
      return "provider_capacity";
    case "reject_invalid_request":
      return "invalid_request";
  }
}
