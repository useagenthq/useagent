import { fleetCapacityConfig } from "../env";
import type { SandboxProvider } from "../sandboxes/provider";
import {
  sandboxProvider,
  sandboxProviderApiKey,
} from "../sandboxes/provider";
import { clearThreadSandbox, getRun } from "../runs/repo";
import { releaseRunSandbox } from "../runs/sandbox-release";
import { finalizeRun, resolveDurableFinalizationOutcome } from "../runs/finalize";
import { settleCommandForRun } from "../commands/dispatch";
import { liveActorRunIds, pumpThread } from "../worker";
import { selectAdmittableThreads } from "./admission";
import {
  type CapacityAdmissionCursor,
  resetLeasedAdmissionsForBoot,
  listQueuedCapacityAdmissions,
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
import { cachedProviderInventory, ensureProviderInventory } from "./inventory";
import type { CapacityInventory } from "./types";

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
const CAPACITY_RECLAIM_PAGE_SIZE = 64;

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

type ReleaseRetainedSandbox = (
  orgId: string,
  runId: string,
) => Promise<{ readonly ok: boolean; readonly released?: boolean }>;

type LoadCapacityReclaimPage = typeof listQueuedCapacityAdmissions;

/**
 * Retained sandboxes make follow-ups fast, but they must yield to queued new
 * work when the host resource budget is full. Evict one oldest idle thread per
 * tick; the normal queue pump below can consume the freed slot immediately.
 */
export async function reclaimRetainedCapacityIfNeeded(
  release: ReleaseRetainedSandbox = releaseRunSandbox,
  loadPage: LoadCapacityReclaimPage = listQueuedCapacityAdmissions,
): Promise<number> {
  const config = fleetCapacityConfig();
  if (
    config.globalMaxActiveSandboxes === 0 ||
    config.orgMaxActiveSandboxes === 0
  ) return 0;
  const provider = cachedProviderInventory();
  let cursor: CapacityAdmissionCursor | undefined;

  while (true) {
    const queuedAdmissions = await loadPage(
      CAPACITY_RECLAIM_PAGE_SIZE,
      cursor,
    );
    if (queuedAdmissions.length === 0) return 0;
    for (const queued of queuedAdmissions) {
      const inventory: CapacityInventory = {
        globalActiveSandboxes: queued.globalActiveSandboxes,
        globalReservedCpuMillicores: queued.globalReservedCpuMillicores,
        globalReservedMemoryMib: queued.globalReservedMemoryMib,
        orgActiveSandboxes: queued.orgActiveSandboxes,
        providerAllocatableCpuMillicores: provider?.allocatableCpuMillicores,
        providerAllocatableMemoryMib: provider?.allocatableMemoryMib,
        providerReadyNodes: provider?.readyNodes,
        providerNodes: provider?.nodes,
      };

      // capacity-policy returns the FIRST failing gate (global count -> org count ->
      // resources), so each row's reason tells us WHICH pressure to verify. A zero
      // count cap cannot be relieved by eviction and must remain non-actionable.
      let pressure = false;
      if (queued.queueReason === "global_limit") {
        pressure = config.globalMaxActiveSandboxes > 0 &&
          inventory.globalActiveSandboxes >= config.globalMaxActiveSandboxes;
      } else if (queued.queueReason === "org_limit") {
        pressure = config.orgMaxActiveSandboxes > 0 &&
          inventory.orgActiveSandboxes >= config.orgMaxActiveSandboxes;
      } else {
        const marginFactor = 1 - config.safetyMarginPct / 100;
        const cpuBudget = Math.floor(config.hostCpuMillicores * marginFactor);
        const memoryBudget = Math.floor(config.hostMemoryMib * marginFactor);
        pressure =
          inventory.globalReservedCpuMillicores + queued.cpuMillicores > cpuBudget ||
          inventory.globalReservedMemoryMib + queued.memoryMib > memoryBudget;
      }
      if (!pressure) continue;
      const candidate = queued.reclaimCandidate;
      if (!candidate) continue;
      const result = await release(candidate.orgId, candidate.runId);
      return result.ok && result.released === true ? 1 : 0;
    }
    const last = queuedAdmissions.at(-1)!;
    cursor = { priority: last.priority, queuedAt: last.queuedAt, runId: last.runId };
  }
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
  const finalized = await finalizeRun(lease.runId, "failed", LEASE_LOST_SUMMARY, durationMs);
  const durable = await resolveDurableFinalizationOutcome(lease.runId, finalized);
  await settleCommandForRun(lease.runId).catch(() => {});
  if (durable) await setAdmissionState(lease.runId, durable.status);
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

  await reclaimRetainedCapacityIfNeeded().catch((err) =>
    console.warn(
      "[fleet] retained sandbox pressure reclaim failed:",
      err instanceof Error ? err.message : err,
    ),
  );

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
