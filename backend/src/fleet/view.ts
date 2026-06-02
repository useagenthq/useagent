import { db } from "../db/client";
import { fleetCapacityConfig } from "../env";
import {
  countOrgOpenAdmissions,
  countOrgQueuedAdmissions,
  getAdmission,
  queuePosition,
} from "./admission-repo";
import { reservationSnapshot } from "./lease-repo";
import { cachedProviderInventory } from "./inventory";
import type { AdmissionState, QueueReason } from "../db/schema/fleet";

// ---------------------------------------------------------------------------
// API read models for fleet capacity. Kept out of routes.ts so the HTTP layer
// stays thin. Two views:
//   - runQueueView: the queue metadata attached to POST /api/runs (ADDITIVE —
//     the response keeps its `id`; the fleet CLI + web UI ignore unknown fields).
//   - orgCapacityView: GET /api/fleet/capacity — org usage vs limit + global
//     capacity health, for the dashboard + operators.
// ---------------------------------------------------------------------------

export interface RunQueueView {
  /** Capacity lifecycle state of this run's admission. */
  readonly state: AdmissionState;
  /** Why it is still queued (null once admitted). */
  readonly reason: QueueReason | null;
  /** Approximate 1-based queue position (0 once admitted). */
  readonly position: number;
}

/** Queue metadata for one run, or null if it has no admission row (legacy path). */
export async function runQueueView(runId: string): Promise<RunQueueView | null> {
  const admission = await getAdmission(runId);
  if (!admission) return null;
  const position =
    admission.state === "queued" ? await queuePosition(runId) : 0;
  return {
    state: admission.state,
    reason: admission.queueReason ?? null,
    position,
  };
}

export interface OrgCapacityView {
  readonly org: {
    readonly activeSandboxes: number;
    readonly maxActiveSandboxes: number;
    readonly queued: number;
    readonly openTotal: number;
    readonly queueDepthLimit: number;
  };
  readonly global: {
    readonly activeSandboxes: number;
    readonly maxActiveSandboxes: number;
    readonly reservedCpuMillicores: number;
    readonly reservedMemoryMib: number;
    readonly hostCpuMillicores: number;
    readonly hostMemoryMib: number;
    readonly safetyMarginPct: number;
    readonly saturated: boolean;
  };
  readonly provider: {
    readonly readyNodes: number | null;
    readonly warmPoolReady: number | null;
    readonly allocatableCpuMillicores: number | null;
    readonly allocatableMemoryMib: number | null;
  };
  readonly limits: {
    readonly maxDispatchConcurrency: number;
  };
}

/** Org usage vs limit + global capacity health for GET /api/fleet/capacity. */
export async function orgCapacityView(orgId: string): Promise<OrgCapacityView> {
  const config = fleetCapacityConfig();
  const [res, queued, openTotal] = await Promise.all([
    reservationSnapshot(orgId, db),
    countOrgQueuedAdmissions(orgId),
    countOrgOpenAdmissions(orgId),
  ]);
  const prov = cachedProviderInventory();
  return {
    org: {
      activeSandboxes: res.orgActiveSandboxes,
      maxActiveSandboxes: config.orgMaxActiveSandboxes,
      queued,
      openTotal,
      queueDepthLimit: config.orgMaxQueueDepth,
    },
    global: {
      activeSandboxes: res.globalActiveSandboxes,
      maxActiveSandboxes: config.globalMaxActiveSandboxes,
      reservedCpuMillicores: res.globalReservedCpuMillicores,
      reservedMemoryMib: res.globalReservedMemoryMib,
      hostCpuMillicores: config.hostCpuMillicores,
      hostMemoryMib: config.hostMemoryMib,
      safetyMarginPct: config.safetyMarginPct,
      saturated: res.globalActiveSandboxes >= config.globalMaxActiveSandboxes,
    },
    provider: {
      readyNodes: prov?.readyNodes ?? null,
      warmPoolReady: prov?.warmPoolReady ?? null,
      allocatableCpuMillicores: prov?.allocatableCpuMillicores ?? null,
      allocatableMemoryMib: prov?.allocatableMemoryMib ?? null,
    },
    limits: {
      maxDispatchConcurrency: config.maxDispatchConcurrency,
    },
  };
}
