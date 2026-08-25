import { fleetCapacityConfig } from "../env";
import type { SandboxProvider } from "../sandboxes/provider";
import {
  sandboxProvider,
  sandboxProviderApiKey,
} from "../sandboxes/provider";
import { clearThreadSandbox, getRun } from "../runs/repo";
import { finalizeRun } from "../runs/finalize";
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
  clearMissingRetainedSandboxMappings,
  claimExpiredLeases,
  heartbeatLeases,
  releaseEmptyActiveLeasesOnBoot,
  releaseReclaimedLease,
  restoreLiveLease,
  scheduleLeaseGcRetry,
  type ReclaimingLease,
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
//      never lingers. Capacity is reclaimed only after provider deletion succeeds.
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
let lastRetainedReconcileAt = 0;

const RETAINED_RECONCILE_INTERVAL_MS = 60_000;

export interface FleetReconcileSummary {
  readonly syncedTerminal: number;
  readonly heartbeated: number;
  readonly expired: number;
  readonly pumped: number;
}

/**
 * Reconcile retained run mappings against a complete provider listing. The
 * listing is collected before any database write, so provider failures preserve
 * every mapping (fail closed).
 */
export async function reconcileRetainedSandboxMappings(
  provider: SandboxProvider,
): Promise<number> {
  const liveSandboxIds = new Set<string>();
  for await (const sandbox of provider.list()) liveSandboxIds.add(sandbox.id);
  return clearMissingRetainedSandboxMappings(liveSandboxIds);
}

async function reconcileRetainedMappingsIfDue(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastRetainedReconcileAt < RETAINED_RECONCILE_INTERVAL_MS) return 0;
  lastRetainedReconcileAt = now;
  try {
    const apiKey = sandboxProviderApiKey();
    if (apiKey === undefined) return 0;
    return await reconcileRetainedSandboxMappings(sandboxProvider(apiKey));
  } catch (error) {
    console.warn(
      "[fleet] retained sandbox reconciliation skipped:",
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
}

async function deleteSandbox(sandboxId: string): Promise<void> {
  const apiKey = sandboxProviderApiKey();
  if (apiKey === undefined) throw new Error("sandbox provider is not configured");
  const provider = sandboxProvider(apiKey);
  const sandbox = await provider.get(sandboxId);
  await sandbox.delete();
}

function gcRetryDelayMs(attempt: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 8));
}

/** Reconcile one dead-worker reservation. Capacity remains reserved while
 * provider GC is failing; only a confirmed delete (or no sandbox ever created)
 * releases it and allows the orphaned run to settle. */
export async function reconcileExpiredLease(
  lease: ReclaimingLease,
  removeSandbox: (sandboxId: string) => Promise<void> = deleteSandbox,
): Promise<void> {
  try {
    if (lease.sandboxId) await removeSandbox(lease.sandboxId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await scheduleLeaseGcRetry(lease.id, message, gcRetryDelayMs(lease.attemptCount));
    console.warn(`[fleet] orphan sandbox ${lease.sandboxId} GC deferred:`, message);
    return;
  }
  await releaseReclaimedLease(lease.id);
  if (lease.sandboxId) {
    await clearThreadSandbox(lease.orgId, lease.threadId, lease.sandboxId);
  }
  const run = await getRun(lease.runId);
  if (!run) return;
  if (run.status === "completed" || run.status === "failed") {
    await setAdmissionState(lease.runId, run.status);
    return;
  }
  const durationMs = Math.max(0, Date.now() - run.createdAt.getTime());
  await finalizeRun(lease.runId, "failed", LEASE_LOST_SUMMARY, durationMs);
  await settleCommandForRun(lease.runId).catch(() => {});
  await setAdmissionState(lease.runId, "failed");
}

/** One reconciliation pass. Safe to call directly in tests. */
export async function reconcileFleetOnce(): Promise<FleetReconcileSummary> {
  const config = fleetCapacityConfig();

  // Refresh provider inventory in the background (never blocks this tick).
  ensureProviderInventory();
  void reconcileRetainedMappingsIfDue();

  const syncedTerminal = await syncTerminalAdmissions();
  await syncRunningAdmissions();
  const heartbeated = await heartbeatLeases(liveActorRunIds(), config.leaseTtlMs);

  const liveAtClaim = liveActorRunIds();
  const expired = await claimExpiredLeases(RECONCILE_BATCH, liveAtClaim);
  const live = new Set(liveActorRunIds());
  for (const lease of expired) {
    // If an actor appeared after the claim snapshot, restore its reservation;
    // never leave a live actor in the reclaiming state.
    if (live.has(lease.runId)) {
      await restoreLiveLease(lease.id, config.leaseTtlMs);
      continue;
    }
    await reconcileExpiredLease(lease).catch((err) =>
      console.error(`[fleet] reconcile expired lease ${lease.id} failed:`, err),
    );
  }

  let pumped = 0;
  const threads = await selectAdmittableThreads(RECONCILE_BATCH);
  for (let offset = 0; offset < threads.length; offset += config.maxDispatchConcurrency) {
    const batch = threads.slice(offset, offset + config.maxDispatchConcurrency);
    const dispatched = await Promise.all(batch.map((threadId) =>
      pumpThread(threadId).catch((err) => {
        console.error(`[fleet] pump thread ${threadId} failed:`, err);
        return null;
      }),
    ));
    pumped += dispatched.filter(Boolean).length;
  }

  return { syncedTerminal, heartbeated, expired: expired.length, pumped };
}

/**
 * Boot reconciliation releases only reservations that never created a sandbox.
 * Real provider boxes stay reserved through recovery/GC. Call before boot run
 * recovery and before the periodic loop starts.
 */
export async function reconcileFleetOnBoot(): Promise<{
  releasedLeases: number;
  resetAdmissions: number;
  syncedTerminal: number;
}> {
  await reconcileRetainedMappingsIfDue(true);
  // Reservations that never reached sandbox creation can be retried directly.
  // Real retained sandboxes remain reserved through restart until recovery
  // adopts/finalizes them or expiry GC confirms deletion.
  const releasedLeases = await releaseEmptyActiveLeasesOnBoot();
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
  lastRetainedReconcileAt = 0;
}
