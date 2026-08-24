import { db, type Executor } from "../db/client";
import { fleetCapacityConfig } from "../env";
import {
  countOrgOpenAdmissions,
  insertRunAdmission,
} from "./admission-repo";
import { resourceClassForRun } from "./resource-class";

// ---------------------------------------------------------------------------
// Accept-time admission intake. Two server-side (durable-authority) guards run
// when a run is accepted, BEFORE any sandbox exists:
//
//   1. Durable per-org queue-depth ceiling — the "clear 429/quota" result when a
//      tenant's backlog is already at the limit. This is the server-side fan-out
//      authority: a client that fires 20 tasks past the ceiling gets rejected
//      durably, not just by a client-side cap.
//   2. The admission ROW insert (resource class resolved from engine/model),
//      committed in the SAME transaction as the run + command.
// ---------------------------------------------------------------------------

/** Thrown when an org's durable queue is full. Ingress maps it to HTTP 429. */
export class FleetQueueLimitError extends Error {
  readonly code = "fleet_queue_full";
  constructor(
    readonly orgId: string,
    readonly limit: number,
  ) {
    super(`fleet queue is full for org ${orgId} (limit ${limit})`);
    this.name = "FleetQueueLimitError";
  }
}

/** Thrown when a single fan-out submits more tasks than the server allows. */
export class FleetFanoutLimitError extends Error {
  readonly code = "fleet_fanout_too_large";
  constructor(
    readonly requested: number,
    readonly limit: number,
  ) {
    super(`fan-out of ${requested} exceeds the limit of ${limit}`);
    this.name = "FleetFanoutLimitError";
  }
}

/** Server-side fan-out cap. Any ingress that submits N tasks in one call passes
 *  N here first; throws past the configured limit. */
export function assertFanoutWithinLimit(taskCount: number): void {
  const { maxFanoutTasks } = fleetCapacityConfig();
  if (taskCount > maxFanoutTasks) {
    throw new FleetFanoutLimitError(taskCount, maxFanoutTasks);
  }
}

export interface AdmissionIntakeInput {
  readonly runId: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly engine: string;
  readonly model: string;
  readonly priority?: number;
}

/**
 * Enforce the durable queue ceiling and persist the admission row. Runs inside
 * the accept transaction (`exec`), so a rejection rolls back cleanly and a
 * success commits atomically with the run + command.
 */
export async function recordAdmissionOnAccept(
  input: AdmissionIntakeInput,
  exec: Executor = db,
): Promise<void> {
  const config = fleetCapacityConfig();
  const open = await countOrgOpenAdmissions(input.orgId, exec);
  if (open >= config.orgMaxQueueDepth) {
    throw new FleetQueueLimitError(input.orgId, config.orgMaxQueueDepth);
  }
  const cls = resourceClassForRun(
    { engine: input.engine, model: input.model },
    config,
  );
  await insertRunAdmission(
    {
      runId: input.runId,
      orgId: input.orgId,
      threadId: input.threadId,
      engine: input.engine,
      model: input.model,
      tier: cls.tier,
      cpuMillicores: cls.cpuMillicores,
      memoryMib: cls.memoryMib,
      priority: input.priority ?? 0,
    },
    exec,
  );
}
