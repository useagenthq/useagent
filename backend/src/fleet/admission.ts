import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { fleetCapacityConfig } from "../env";
import { evaluateAdmission } from "./capacity-policy";
import {
  getAdmission,
  listQueuedAdmissions,
  markAdmissionLeased,
  markAdmissionQueued,
  setAdmissionState,
} from "./admission-repo";
import { createLease, releaseLeaseForRun } from "./lease-repo";
import { activeProviderLabel, buildCapacityInventory } from "./inventory";
import {
  queueReasonForDecision,
  type AdmissionDecisionKind,
} from "./types";
import { getRun } from "../runs/repo";

// ---------------------------------------------------------------------------
// The capacity GATE — the single seam the worker consults before spawning a
// run's actor. It runs the provider-neutral policy against a durable inventory
// snapshot and, if admitted, mints a lease reserving the run's declared
// resources. Admission DECISIONS are serialized by a Postgres advisory lock so
// two concurrent claims can never both consume the last capacity slot; the count
// + lease insert commit together. This module performs NO spawning (that would
// import the worker and cycle) — it returns a decision and the caller spawns.
// ---------------------------------------------------------------------------

export interface AdmitResult {
  readonly admit: boolean;
  readonly leaseId: string | null;
  readonly decision: AdmissionDecisionKind;
}

/**
 * Decide whether a claimed run may start a sandbox now. Idempotent: a run with no
 * admission row (legacy / direct createRun) always admits (behavior-preserving);
 * an already-leased run returns its existing lease; a terminal admission never
 * re-admits. On a fresh admit a lease is created and the admission moves to
 * `leased`; on a deferral the admission stays `queued` with the reason recorded.
 */
export async function admitClaimedRun(runId: string): Promise<AdmitResult> {
  const config = fleetCapacityConfig();
  return db.transaction(async (tx) => {
    // Serialize capacity decisions across the process/database (Stage A).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('fleet-admission'))`);

    const adm = await getAdmission(runId, tx);
    if (!adm) return { admit: true, leaseId: null, decision: "admit" };
    if (adm.state === "leased" || adm.state === "running") {
      return { admit: true, leaseId: adm.workerLeaseId ?? null, decision: "admit" };
    }
    if (adm.state !== "queued") {
      // Terminal (completed/failed/canceled) — do not resurrect.
      return { admit: false, leaseId: null, decision: "reject_invalid_request" };
    }

    const inventory = await buildCapacityInventory(adm.orgId, tx);
    const decision = evaluateAdmission(
      {
        orgId: adm.orgId,
        engine: adm.engine,
        model: adm.model,
        tier: adm.tier,
        cpuMillicores: adm.cpuMillicores,
        memoryMib: adm.memoryMib,
      },
      inventory,
      config,
    );

    if (decision.decision === "admit") {
      const leaseId = await createLease(
        {
          runId,
          threadId: adm.threadId,
          orgId: adm.orgId,
          provider: activeProviderLabel(),
          tier: adm.tier,
          cpuMillicores: adm.cpuMillicores,
          memoryMib: adm.memoryMib,
          leaseTtlMs: config.leaseTtlMs,
        },
        tx,
      );
      await markAdmissionLeased(runId, leaseId, tx);
      return { admit: true, leaseId, decision: "admit" };
    }

    const reason = queueReasonForDecision(decision.decision);
    if (reason) await markAdmissionQueued(runId, reason, {}, tx);
    return { admit: false, leaseId: null, decision: decision.decision };
  });
}

/** Release a run's capacity lease and, if the run is terminal, sync its
 *  admission to that terminal state. Reads the run's current status so it is
 *  correct from any caller. Idempotent — safe on every terminal path. A run that
 *  was merely requeued (not terminal) simply has no active lease to release. */
export async function releaseOnSettle(runId: string): Promise<void> {
  await releaseLeaseForRun(runId);
  const run = await getRun(runId);
  if (run && (run.status === "completed" || run.status === "failed")) {
    await setAdmissionState(runId, run.status);
  }
}

/** Distinct threads with queued (capacity-deferred) work, highest priority
 *  first — the reconciler's + settle path's pump list. pumpThread no-ops any
 *  thread that is already busy, so an over-broad list is harmless. */
export async function selectAdmittableThreads(limit: number): Promise<string[]> {
  const queued = await listQueuedAdmissions(limit);
  const seen = new Set<string>();
  const threads: string[] = [];
  for (const q of queued) {
    if (seen.has(q.threadId)) continue;
    seen.add(q.threadId);
    threads.push(q.threadId);
  }
  return threads;
}
