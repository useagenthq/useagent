import { fleetCapacityConfig } from "../env";
import {
  sandboxProvider,
  sandboxProviderApiKey,
} from "../sandboxes/provider";
import { completeRun, getRun } from "../runs/repo";
import { settleCommandForRun } from "../commands/dispatch";
import { liveActorRunIds, pumpThread } from "../worker";
import { selectAdmittableThreads } from "./admission";
import {
  resetLeasedAdmissionsForBoot,
  setAdmissionState,
  syncRunningAdmissions,
  syncTerminalAdmissions,
} from "./admission-repo";
import {
  claimExpiredLeases,
  heartbeatLeases,
  releaseAllActiveLeasesOnBoot,
  type ExpiredLease,
} from "./lease-repo";
import { ensureProviderInventory } from "./inventory";

// ---------------------------------------------------------------------------
// Fleet reconciliation worker (HA Stage A). One periodic tick, wired into the
// existing worker-loop family (index.ts), keeps the durable queue + leases
// converging on the truth:
//
//   1. Sync admissions of runs that settled out of band (adopted by recovery).
//   2. Heartbeat leases of live actors (extend expiry) — the crash detector.
//   3. Claim expired leases (dead workers), reconcile each against the provider
//      (delete the orphaned sandbox), and terminally fail the orphaned run so it
//      never lingers. Capacity is reclaimed the moment the lease flips.
//   4. Admit queued work up to freed capacity by pumping the head-of-thread runs;
//      the capacity gate (pumpThread -> admitClaimedRun) is the authority, so an
//      over-broad pump list is harmless.
//
// The tick is single-flight with a watchdog (mirrors runs/recovery's reconcile
// loop). Everything is transactional + DB-backed, so nothing depends on a
// process-local map surviving a restart.
// ---------------------------------------------------------------------------

const LEASE_LOST_SUMMARY =
  "Run reclaimed after its worker lease expired (worker crash or overrun).";

/** Bound the work per tick so a large backlog drains over several ticks rather
 *  than one long transaction storm. */
const RECONCILE_BATCH = 64;

let loopTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let tickStartedAt = 0;

export interface FleetReconcileSummary {
  readonly syncedTerminal: number;
  readonly heartbeated: number;
  readonly expired: number;
  readonly pumped: number;
}

async function deleteSandboxBestEffort(sandboxId: string): Promise<void> {
  const apiKey = sandboxProviderApiKey();
  if (apiKey === undefined) return;
  try {
    const provider = sandboxProvider(apiKey);
    const sandbox = await provider.get(sandboxId);
    await sandbox.delete();
  } catch (err) {
    console.warn(
      `[fleet] orphan sandbox ${sandboxId} delete failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Reconcile ONE expired lease: GC its sandbox, then terminally fail the run if
 *  it is still non-terminal (its actor is gone). A terminal run just syncs. */
async function reconcileExpiredLease(lease: ExpiredLease): Promise<void> {
  if (lease.sandboxId) await deleteSandboxBestEffort(lease.sandboxId);
  const run = await getRun(lease.runId);
  if (!run) return;
  if (run.status === "completed" || run.status === "failed") {
    await setAdmissionState(lease.runId, run.status);
    return;
  }
  const durationMs = Math.max(0, Date.now() - run.createdAt.getTime());
  const failed = await completeRun(lease.runId, "failed", LEASE_LOST_SUMMARY, durationMs);
  if (failed) await settleCommandForRun(lease.runId).catch(() => {});
  await setAdmissionState(lease.runId, "failed");
}

/** One reconciliation pass. Safe to call directly in tests. */
export async function reconcileFleetOnce(): Promise<FleetReconcileSummary> {
  const config = fleetCapacityConfig();

  // Refresh provider inventory in the background (never blocks this tick).
  ensureProviderInventory();

  const syncedTerminal = await syncTerminalAdmissions();
  await syncRunningAdmissions();
  const heartbeated = await heartbeatLeases(liveActorRunIds(), config.leaseTtlMs);

  const expired = await claimExpiredLeases(RECONCILE_BATCH);
  const live = new Set(liveActorRunIds());
  for (const lease of expired) {
    // Guard the tiny heartbeat/claim race: if the actor came alive, skip.
    if (live.has(lease.runId)) continue;
    await reconcileExpiredLease(lease).catch((err) =>
      console.error(`[fleet] reconcile expired lease ${lease.id} failed:`, err),
    );
  }

  let pumped = 0;
  const threads = await selectAdmittableThreads(RECONCILE_BATCH);
  for (const threadId of threads) {
    const dispatched = await pumpThread(threadId).catch((err) => {
      console.error(`[fleet] pump thread ${threadId} failed:`, err);
      return null;
    });
    if (dispatched) pumped += 1;
  }

  return { syncedTerminal, heartbeated, expired: expired.length, pumped };
}

/**
 * Boot reconciliation: the process that owned every active lease is gone, so
 * release them all (capacity zeroed) and unbind non-terminal admissions so boot
 * recovery's re-pump mints fresh leases. Terminal runs are synced. Call BEFORE
 * the periodic loop starts, alongside recoverStaleRuns.
 */
export async function reconcileFleetOnBoot(): Promise<{
  releasedLeases: number;
  resetAdmissions: number;
  syncedTerminal: number;
}> {
  const releasedLeases = await releaseAllActiveLeasesOnBoot();
  const resetAdmissions = await resetLeasedAdmissionsForBoot();
  const syncedTerminal = await syncTerminalAdmissions();
  return { releasedLeases, resetAdmissions, syncedTerminal };
}

/** Start the periodic reconciler (idempotent). Single-flight with a watchdog so
 *  a stuck tick can never wedge the loop. Unref'd so it never holds the process
 *  open. */
export function startFleetReconciler(
  intervalMs = Number(process.env.FLEET_TICK_MS ?? 5_000),
): void {
  if (loopTimer) return;
  const watchdogMs = Math.max(intervalMs * 8, 120_000);
  loopTimer = setInterval(() => {
    if (ticking) {
      if (Date.now() - tickStartedAt < watchdogMs) return;
      console.error("[fleet] reconcile tick exceeded watchdog; resetting");
    }
    ticking = true;
    tickStartedAt = Date.now();
    void reconcileFleetOnce()
      .catch((err) => console.error("[fleet] reconcile tick failed:", err))
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  if (typeof loopTimer.unref === "function") loopTimer.unref();
}

/** Stop the loop (tests / shutdown). */
export function stopFleetReconciler(): void {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  ticking = false;
}
