import {
  resolveHarness,
  resolveProviderDriverForSession,
} from "../engines";
import type {
  HarnessCheckpoint,
  HarnessInterimEvent,
  HarnessReconciliation,
  HarnessSessionHandle,
} from "../engines/types";
import { getLastStepAt, getRun, STALE_SUMMARY } from "./repo";
import { finalizeRun, resolveDurableFinalizationOutcome } from "./finalize";
import {
  providerEventExists,
  recordProviderEvent,
  scopedProviderEventId,
} from "./provider-events";
import { orgSecretRedactor } from "../secrets/store";
import {
  bumpReconcile,
  claimDueReconciles,
  deleteReconcile,
  enqueueReconcile,
  nextReconcileAction,
  reconcileBackoffAt,
  RECONCILE_PARK_BUDGET_MS,
  type ReconcileEntry,
} from "./reconcile-queue";
import {
  failCommandlessStaleRuns,
  listActiveCommands,
  settleCommandForRun,
  type ActiveCommand,
} from "../commands/dispatch";
import { pumpThread } from "../worker";
import { assertNever } from "../util/exhaustive";
import { CANCEL_SUMMARY, hasRunCancelIntent } from "../commands/cancel";
import {
  parseProviderSessionBinding,
  type ProviderSessionBinding,
} from "@useagent/agent-harness/canonical";
import {
  providerProtocolIdentity,
} from "@useagent/agent-harness/control";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { providerSessionAuthIsCurrent } from "../engines/provider-session-authority";
import { resolveSandboxBindingForSandbox } from "../sandboxes/binding";
import { piBridgeManager } from "../engines/pi-rpc-bridge";

/** The event type for the durable "reconciling after restart" marker. Distinct
 *  from the terminal events so the timeline can show a run is being re-probed. */
export const RUN_RECONCILING = "run.reconciling";
export const INCOMPATIBLE_PROVIDER_SESSION_SUMMARY =
  "This run stopped after an engine protocol upgrade. Retry the turn to start a fresh native session.";

// ---------------------------------------------------------------------------
// Restart recovery of the durable command lane (north star Phase 3 "Restart
// recovery" + Crash Recovery Matrix). On boot the in-memory workers are gone,
// so the mailbox on the `commands` table is the source of truth. Three phases:
//
//  1. RESOLVE each in-flight (dispatched) command against its run:
//       running  → reconcile the native session (completed) or fail honestly,
//                  then mark the command completed;
//       terminal → mark the command completed (crash between run-done and the
//                  command settle — Crash Matrix "provider completed while useAgent
//                  says terminal"): frees the thread for the next turn;
//       queued   → requeue the command (worker died before the run started).
//  2. PUMP every thread with a queued command → dispatch its head (order +
//     one-in-flight preserved by the mailbox); cross-thread concurrent.
//  3. FAIL any non-terminal run with no active command (legacy/orphan).
//
// ONE-SHOT boot pass — no background loops. Bounded per-run probes run
// concurrently, so total boot time is ~one probe budget.
// ---------------------------------------------------------------------------

/** Hard per-run backstop; the harness reconcile bounds its own work to ~9s. */
const RECONCILE_BUDGET_MS = 11_000;

/** The native-session probe (HarnessAdapter.reconcile). Injectable for tests. */
export type ReconcileProbe = (
  handle: HarnessSessionHandle,
  checkpoint: HarnessCheckpoint,
) => Promise<HarnessReconciliation>;

/** Default probe: resolve the control adapter for the run's provider from the
 *  engine registry (no direct concrete-harness import). A provider with no
 *  registered harness surfaces as unreachable and is handled by the caller's
 *  switch; a registered ACP harness honestly returns `unsupported_capability`.
 *  For OpenCode runs this resolves to `opencodeHarness`, so behavior is unchanged. */
const defaultReconcile: ReconcileProbe = (handle, checkpoint) => {
  const harness = resolveHarness(handle.provider);
  return harness
    ? harness.reconcile(handle, checkpoint)
    : Promise.resolve({ status: "unreachable" } as HarnessReconciliation);
};

export type RestartTransportCleanup = (input: {
  readonly engine: string;
  readonly sandboxId: string | null;
}) => Promise<void>;

const defaultRestartTransportCleanup: RestartTransportCleanup = async (input) => {
  if (input.engine !== "pi") return;
  if (!input.sandboxId) throw new Error("Pi restart cleanup has no sandbox identity");
  const binding = await resolveSandboxBindingForSandbox(input.sandboxId);
  const sandbox = await binding.provider.get(input.sandboxId);
  await piBridgeManager.prepare(sandbox);
};

export interface RecoveryResult {
  readonly reconciled: number;
  readonly failed: number;
  readonly redispatched: number;
  /** Runs whose one-shot probe was transient and were PARKED for the adaptive
   *  background re-probe instead of honest-failed at boot (#63). */
  readonly parked: number;
}

export async function recoverStaleRuns(
  reconcile: ReconcileProbe = defaultReconcile,
  cleanup: RestartTransportCleanup = defaultRestartTransportCleanup,
): Promise<RecoveryResult> {
  const active = await listActiveCommands();

  // Phase 1 — resolve in-flight commands (concurrent; different threads are
  // independent, and a thread has at most one dispatched command).
  const dispatched = active.filter((c) => c.state === "dispatched");
  const resolutions = await Promise.all(dispatched.map((c) => resolveDispatched(c, reconcile, cleanup)));
  const reconciled = resolutions.filter((r) => r === "reconciled").length;
  const parked = resolutions.filter((r) => r === "parked").length;
  let failed = resolutions.filter((r) => r === "failed").length;

  // Phase 2 — pump each distinct thread that had an active command. dispatched
  // ones are now completed/requeued, so a queued head can claim the thread.
  const threads = [...new Set(active.map((c) => c.threadId))];
  const pumped = await Promise.all(threads.map((t) => pumpThread(t)));
  const redispatched = pumped.filter((runId) => runId !== null).length;

  // Phase 3 — fail legacy/orphan non-terminal runs that never joined the lane.
  failed += await failCommandlessStaleRuns(STALE_SUMMARY);

  return { reconciled, failed, redispatched, parked };
}

type DispatchedResolution = "reconciled" | "failed" | "parked" | "settled";

/** Resolve one dispatched command: reconcile / fail / PARK a still-running run,
 *  then settle its command (completed/requeued) so the thread is freed — EXCEPT a
 *  parked run keeps its command dispatched (the thread stays reserved because the
 *  run may still be running; the reconcile loop settles it later). */
async function resolveDispatched(
  cmd: ActiveCommand,
  reconcile: ReconcileProbe,
  cleanup: RestartTransportCleanup,
): Promise<DispatchedResolution> {
  if (cmd.engine === "pi") {
    await cleanup({ engine: cmd.engine, sandboxId: cmd.sandboxId });
  }
  let outcome: DispatchedResolution = "settled";
  if (cmd.runStatus === "running") {
    outcome = await recoverRunningRun(cmd, reconcile);
  }
  if (outcome === "parked") return outcome; // keep the command dispatched
  // The run is now terminal (reconciled/failed) or was already terminal/queued;
  // settle the command to completed (terminal) or requeued (queued).
  await settleCommandForRun(cmd.runId);
  return outcome;
}

async function recoverRunningRun(
  cmd: ActiveCommand,
  reconcile: ReconcileProbe,
): Promise<"reconciled" | "failed" | "parked"> {
  if (cmd.cancelRequested) {
    const finalized = await finalizeRun(cmd.runId, "failed", CANCEL_SUMMARY, 0);
    const durable = await resolveDurableFinalizationOutcome(cmd.runId, finalized);
    return durable?.status === "completed" ? "reconciled" : "failed";
  }
  const binding = cmd.providerSession;
  const authCurrent = binding
    ? await providerSessionAuthIsCurrent({
        binding,
        orgId: cmd.orgId,
        userId: cmd.userId,
      })
    : false;
  const identityCurrent = Boolean(
    binding &&
    authCurrent &&
    binding.runtime.kind === "sandbox" &&
    binding.runtime.id === cmd.sandboxId &&
    binding.nativeSessionId === cmd.engineSessionId,
  );
  const driver = binding && identityCurrent
    ? resolveProviderDriverForSession(cmd.engine, binding, binding.authEpoch)
    : undefined;
  if (identityCurrent && !driver) {
    const finalized = await finalizeRun(
      cmd.runId,
      "failed",
      INCOMPATIBLE_PROVIDER_SESSION_SUMMARY,
      0,
    );
    const durable = await resolveDurableFinalizationOutcome(cmd.runId, finalized);
    return durable?.status === "completed" ? "reconciled" : "failed";
  }
  if (!identityCurrent) {
    const finalized = await finalizeRun(cmd.runId, "failed", STALE_SUMMARY, 0);
    const durable = await resolveDurableFinalizationOutcome(cmd.runId, finalized);
    return durable?.status === "completed" ? "reconciled" : "failed";
  }

  const lastStepAt = await getLastStepAt(cmd.runId);
  const redact = await orgSecretRedactor(cmd.orgId);
  const handle: HarnessSessionHandle = {
    provider: binding!.provider,
    sessionId: binding!.nativeSessionId,
    sandboxId: binding!.runtime.id,
    protocol: binding!.protocol,
    generation: binding!.generation,
    authEpoch: binding!.authEpoch,
    currentAuthEpoch: binding!.authEpoch,
  };

  let result: HarnessReconciliation;
  try {
    result = await Promise.race([
      reconcile(handle, {
        sinceMs: lastStepAt?.getTime() ?? 0,
        eventContext: { runId: cmd.runId, threadId: cmd.threadId, redact },
      }),
      new Promise<HarnessReconciliation>((resolve) =>
        setTimeout(() => resolve({ status: "unreachable" }), RECONCILE_BUDGET_MS),
      ),
    ]);
  } catch {
    result = { status: "unreachable" };
  }

  switch (result.status) {
    case "completed":
    case "failed": {
      if (result.events?.length) {
        try {
          await ingestReconciliationEvents(cmd, redact, result.events, true);
        } catch (error) {
          try {
            await parkRunningRun(cmd, binding!, lastStepAt);
          } catch (parkError) {
            throw new AggregateError(
              [error, parkError],
              `Terminal event backfill and retry parking failed for run ${cmd.runId}`,
            );
          }
          console.error(`[reconcile] terminal event backfill for run ${cmd.runId} failed; parked for retry:`, error);
          return "parked";
        }
      }
      // Finalize only after the current native turn's tail is durable. Completed
      // adoption still enqueues memory capture in the finalizer transaction;
      // native failure/interruption keeps its specific recovered reason.
      const finalized = await finalizeRun(cmd.runId, result.status, result.summary, 0);
      const durable = await resolveDurableFinalizationOutcome(cmd.runId, finalized);
      return durable?.status === "completed" ? "reconciled" : "failed";
    }
    case "in_progress":
    case "no_change":
    case "unreachable":
    case "unsupported_capability": {
      // ADAPTIVE (#63): the sandbox session may still be finishing after a fast
      // restart. Instead of honest-failing NOW, PARK for a bounded background
      // re-probe (the run stays `running`). enqueue is idempotent, so a re-boot
      // re-parks against the ORIGINAL deadline. A freshly parked run gets the
      // "reconciling" marker; a non-candidate already failed above.
      await parkRunningRun(cmd, binding!, lastStepAt);
      return "parked";
    }
    default:
      return assertNever(result, "unhandled reconciliation status");
  }
}

async function parkRunningRun(
  cmd: ActiveCommand,
  binding: ProviderSessionBinding,
  lastStepAt: Date | null,
): Promise<void> {
  const now = Date.now();
  const newlyParked = await enqueueReconcile({
    runId: cmd.runId,
    threadId: cmd.threadId,
    sandboxId: binding.runtime.id,
    sessionId: binding.nativeSessionId,
    sinceAt: lastStepAt ?? new Date(now),
    nextAttemptAt: reconcileBackoffAt(now, 0),
    deadline: new Date(now + RECONCILE_PARK_BUDGET_MS),
  });
  if (newlyParked) {
    recordReconcilingMarker(cmd.runId, cmd.threadId, {
      reason: "boot-restart",
      sinceMs: (lastStepAt ?? new Date(now)).getTime(),
      deadlineMs: now + RECONCILE_PARK_BUDGET_MS,
    });
  }
}

/** Payload of the durable "reconciling after restart" marker. `reason` is
 *  "boot-restart" for the initial park frame and "reprobe" for a re-probe
 *  heartbeat; the heartbeat also carries `lastProbeAt` + `eventsRecovered`. */
interface ReconcilingMarkerPayload {
  reason: "boot-restart" | "reprobe";
  sinceMs: number;
  deadlineMs: number;
  lastProbeAt?: number;
  eventsRecovered?: number;
}

/** Upsert the durable "reconciling after restart" marker on the native lane so
 *  the timeline shows the run is being re-probed. Frozen frame contract (#63):
 *  provider "skynet", eventType "run.reconciling". The id is STABLE per run, so
 *  the boot-park frame and every re-probe heartbeat address the SAME row — one
 *  marker that keeps advancing (each upsert mints a fresh seq → SSE subscribers
 *  see a live heartbeat) instead of a frozen frame or a pile of duplicate rows.
 *  Fire-and-forget; never throws. */
function recordReconcilingMarker(runId: string, threadId: string, payload: ReconcilingMarkerPayload): void {
  void recordProviderEvent({
    id: `reconciling_${runId}`,
    runId,
    threadId,
    provider: "skynet",
    eventType: RUN_RECONCILING,
    payload,
  }).catch(() => {});
}

/** Append native events a reconciliation surfaced to the canonical run, so SSE
 *  subscribers watch progress and terminal tail activity is durable before seal.
 *  Idempotent: recordProviderEvent upserts on the stable provider event id
 *  (the run-scoped OpenCode part id), the SAME key the live lane uses, so
 *  re-probes and the pre-restart lane never create a duplicate row or collide
 *  with another run. Payloads are redacted like the live lane. Returns the
 *  number durably present after this probe; strict terminal ingestion throws so
 *  the caller retains the run for retry instead of sealing incomplete history. */
async function ingestReconciliationEvents(
  entry: Pick<ReconcileEntry, "runId" | "threadId">,
  redact: Awaited<ReturnType<typeof orgSecretRedactor>>,
  events: readonly HarnessInterimEvent[],
  strict = false,
): Promise<number> {
  let recovered = 0;
  for (const ev of events) {
    try {
      if (ev.runScopedId && !ev.id.startsWith(`pe_${entry.runId}_`)) {
        throw new Error(`Recovered event id does not match run ${entry.runId}`);
      }
      const eventId = ev.runScopedId ? ev.id : scopedProviderEventId(entry.runId, ev.id);
      await recordProviderEvent({
          id: eventId,
          runId: entry.runId,
          threadId: entry.threadId,
          provider: ev.provider,
          eventType: ev.eventType,
          nativeSessionId: ev.sessionId ?? null,
          nativeParentSessionId: ev.parentSessionId ?? null,
          nativeMessageId: ev.messageId ?? null,
          nativePartId: ev.partId ?? null,
          nativeCallId: ev.callId ?? null,
          payload: redact.unknown(ev.payload),
        },
        { critical: strict, required: strict },
      );
      if (await providerEventExists(eventId)) recovered++;
      else if (strict) throw new Error(`Recovered event ${eventId} was not durable`);
    } catch (error) {
      if (strict) throw error;
      /* a single malformed event must never abort the probe */
    }
  }
  return recovered;
}

// ---------------------------------------------------------------------------
// Adaptive background reconcile loop (#63). Re-probes parked runs on a short
// backoff within their budget: adopt the finished session, honest-fail after the
// deadline, else reschedule. Single-flight with a watchdog; because the watchdog can
// resurrect a tick over one that is merely slow, every claim is a leased row lock
// (reconcile-queue.ts), so two ticks in flight never probe the same run. Never throws;
// a tick error is logged.
// ---------------------------------------------------------------------------

/** Parked runs one tick processes at most. */
const RECONCILE_BATCH = 20;

// Every row write for a claimed entry is fenced on the lease the claim holds. The probe
// race is bounded (RECONCILE_BUDGET_MS) but the reads and the finalize around it are not,
// so a tick can outlive its lease; once the watchdog has resurrected a replacement and it
// has re-claimed the row, the stale tick learns it here and leaves the row alone. Its
// probe was wasted, nothing else: finalization is first-writer-wins on its own.
function lostClaim(entry: ReconcileEntry): void {
  console.warn(
    `[reconcile] entry ${entry.runId} outlived its lease and was re-claimed by another tick; leaving the row to it`,
  );
}
async function settleEntry(entry: ReconcileEntry): Promise<void> {
  if (!(await deleteReconcile(entry.runId, entry.leaseUntil))) lostClaim(entry);
}
async function rescheduleEntry(entry: ReconcileEntry): Promise<void> {
  const next = reconcileBackoffAt(Date.now(), entry.attempts);
  if (!(await bumpReconcile(entry.runId, next, entry.leaseUntil))) lostClaim(entry);
}

/** One reconcile tick: process every DUE parked run. Returns counts for
 *  tests/telemetry. The probe is injectable (tests). Never throws. */
export async function runDueReconciles(
  reconcile: ReconcileProbe = defaultReconcile,
  cleanup: RestartTransportCleanup = defaultRestartTransportCleanup,
): Promise<{ adopted: number; failed: number; retried: number; dropped: number; eventsRecovered: number }> {
  let adopted = 0;
  let failed = 0;
  let retried = 0;
  let dropped = 0;
  let eventsRecovered = 0;
  // Claim ONE leased row at a time: the lease then covers exactly the entry being probed,
  // so a batch that outlives one lease never re-exposes a row it has yet to reach, and a
  // tick running alongside this one claims disjoint rows.
  for (let claimed = 0; claimed < RECONCILE_BATCH; claimed++) {
    const [entry] = await claimDueReconciles(1);
    if (!entry) break;
   // PER-ENTRY ISOLATION: a throw on ONE entry (a stuck finalize, a DB error)
   // must not abort the whole batch and leave every other parked run stranded.
   // Combined with the tick watchdog in startReconcileLoop, a single wedged
   // entry can no longer freeze the reconciler for all runs (the 2026-08-20
   // 25-minute idle: one post-park tick never settled, single-flight then
   // blocked every later tick forever).
   try {
    // NO-DOUBLE-ADOPT: if the run already settled via another lane (a reply's
    // worker took the thread, a cancel, a prior tick), just drop the parked row.
    const run = await getRun(entry.runId);
    if (!run || run.status !== "running") {
      await settleEntry(entry);
      dropped++;
      continue;
    }
    if (run.engine === "pi") {
      await cleanup({ engine: run.engine, sandboxId: run.sandboxId });
    }
    if (run.orgId && await hasRunCancelIntent(run.orgId, run.id)) {
      const finalized = await finalizeRun(entry.runId, "failed", CANCEL_SUMMARY, 0);
      const durable = await resolveDurableFinalizationOutcome(entry.runId, finalized);
      await settleAndPump(entry.runId, entry.threadId);
      await settleEntry(entry);
      if (durable?.status === "completed") adopted++;
      else failed++;
      continue;
    }
    const binding = parseProviderSessionBinding(run.providerSession);
    const authCurrent = binding
      ? await providerSessionAuthIsCurrent({ binding, orgId: run.orgId, userId: run.userId })
      : false;
    const redact = await orgSecretRedactor(run.orgId);
    const result = await probeParked(entry, authCurrent ? binding : null, redact, reconcile);
    // CONTINUITY (#63): ingest reachable native activity before deciding whether
    // to retry or adopt. Completed-event ingestion is strict because finalization
    // seals the run; in-progress activity remains best-effort timeline continuity.
    // A provider that cannot surface events (ACP) simply returns none.
    const recoveredEvents = result.status === "completed" ||
      result.status === "failed" ||
      result.status === "in_progress"
      ? result.events
      : undefined;
    let recovered = 0;
    try {
      recovered = recoveredEvents?.length
        ? await ingestReconciliationEvents(entry, redact, recoveredEvents, result.status !== "in_progress")
        : 0;
    } catch (error) {
      console.error(`[reconcile] terminal event backfill for run ${entry.runId} failed; retained for retry:`, error);
      if (nextReconcileAction(false, Date.now(), entry.deadlineMs) === "fail") {
        const finalized = await finalizeRun(entry.runId, "failed", STALE_SUMMARY, 0);
        const durable = await resolveDurableFinalizationOutcome(entry.runId, finalized);
        await settleAndPump(entry.runId, entry.threadId);
        await settleEntry(entry);
        if (durable?.status === "completed") adopted++;
        else failed++;
        continue;
      }
      await rescheduleEntry(entry);
      retried++;
      continue;
    }
    eventsRecovered += recovered;
    if (result.status === "failed") {
      const finalized = await finalizeRun(entry.runId, "failed", result.summary, 0);
      const durable = await resolveDurableFinalizationOutcome(entry.runId, finalized);
      await settleAndPump(entry.runId, entry.threadId);
      await settleEntry(entry);
      if (durable?.status === "completed") adopted++;
      else failed++;
      continue;
    }
    const action = nextReconcileAction(result.status === "completed", Date.now(), entry.deadlineMs);
    if (action === "adopt") {
      const finalized = await finalizeRun(
        entry.runId,
        "completed",
        (result as { summary: string }).summary,
        0,
      );
      const durable = await resolveDurableFinalizationOutcome(entry.runId, finalized);
      await settleAndPump(entry.runId, entry.threadId);
      await settleEntry(entry);
      if (durable?.status === "completed") adopted++;
      else failed++;
    } else if (action === "fail") {
      const finalized = await finalizeRun(entry.runId, "failed", STALE_SUMMARY, 0);
      const durable = await resolveDurableFinalizationOutcome(entry.runId, finalized);
      await settleAndPump(entry.runId, entry.threadId);
      await settleEntry(entry);
      if (durable?.status === "completed") adopted++;
      else failed++;
    } else {
      // Retry: heartbeat the reconciling marker so the row shows liveness — but
      // ONLY when we actually reached the session (in_progress / no_change). An
      // unreachable probe learns nothing, so it must not fake a heartbeat.
      if (result.status === "in_progress" || result.status === "no_change") {
        recordReconcilingMarker(entry.runId, entry.threadId, {
          reason: "reprobe",
          sinceMs: entry.sinceMs,
          deadlineMs: entry.deadlineMs,
          lastProbeAt: Date.now(),
          eventsRecovered: recovered,
        });
      }
      await rescheduleEntry(entry);
      retried++;
    }
   } catch (err) {
     // Bump this entry's next attempt so a persistently failing one backs off
     // instead of hot-looping, and move on to the rest of the batch.
     console.error(`[reconcile] entry ${entry.runId} failed, skipping:`, err);
     await rescheduleEntry(entry).catch(() => {});
   }
  }
  return { adopted, failed, retried, dropped, eventsRecovered };
}

/** Bounded native-session re-probe for one parked entry. Never throws. */
async function probeParked(
  entry: ReconcileEntry,
  binding: ProviderSessionBinding | null,
  redact: Awaited<ReturnType<typeof orgSecretRedactor>>,
  reconcile: ReconcileProbe,
): Promise<HarnessReconciliation> {
  if (
    !binding ||
    binding.runtime.kind !== "sandbox" ||
    binding.runtime.id !== entry.sandboxId ||
    binding.nativeSessionId !== entry.sessionId
  ) {
    return { status: "unreachable" };
  }
  const handle: HarnessSessionHandle = {
    provider: binding.provider,
    sessionId: binding.nativeSessionId,
    sandboxId: binding.runtime.id,
    protocol: binding.protocol,
    generation: binding.generation,
    authEpoch: binding.authEpoch,
    currentAuthEpoch: binding.authEpoch,
  };
  try {
    return await Promise.race([
      reconcile(handle, {
        sinceMs: entry.sinceMs,
        eventContext: { runId: entry.runId, threadId: entry.threadId, redact },
      }),
      new Promise<HarnessReconciliation>((resolve) =>
        setTimeout(() => resolve({ status: "unreachable" }), RECONCILE_BUDGET_MS),
      ),
    ]);
  } catch {
    return { status: "unreachable" };
  }
}

/** Settle the just-finalized run's command and pump the thread's next turn —
 *  the same free-the-thread step the live worker runs on every terminal. */
async function settleAndPump(runId: string, threadId: string): Promise<void> {
  await settleCommandForRun(runId).catch((err) =>
    console.error(`[reconcile] settle command for run ${runId} failed:`, err),
  );
  await pumpThread(threadId).catch((err) =>
    console.error(`[reconcile] pump thread ${threadId} failed:`, err),
  );
}

let reconcileTimer: ReturnType<typeof setInterval> | null = null;

export interface TickStart { readonly generation: number; readonly resurrected: boolean }

/** Single-flight guard with a watchdog and tick OWNERSHIP. `start` hands out a generation
 *  when a tick may run: nothing is in flight, or the in-flight tick is past the watchdog
 *  and is treated as lost. `settle` frees the guard only for the generation that holds
 *  it, so a lost tick that finally settles cannot free the guard from under its
 *  replacement (which would let the next interval start a third tick over the second).
 *  Pure, so it is tested without timers. */
export function createTickGuard(watchdogMs: number) {
  let generation = 0;
  let inFlight: { generation: number; startedAt: number } | null = null;
  return {
    start(now: number): TickStart | null {
      if (inFlight && now - inFlight.startedAt < watchdogMs) return null;
      const resurrected = inFlight !== null;
      inFlight = { generation: ++generation, startedAt: now };
      return { generation: inFlight.generation, resurrected };
    },
    settle(gen: number): void {
      if (inFlight?.generation === gen) inFlight = null;
    },
  };
}

/** Start the adaptive reconcile loop (idempotent). Single-flight: a slow tick is
 *  never overlapped by the next. `RECONCILE_TICK_MS` overrides the interval
 *  (tests go fast). Best-effort — a tick failure is logged, never thrown.
 *
 *  WATCHDOG: single-flight used to be permanent - if a tick's promise never
 *  settled (an unbounded DB await wedged), the flag stayed set and every later
 *  interval early-returned, killing the reconciler for good (the 2026-08-20
 *  25-minute idle). A tick still in flight past the watchdog window is treated as
 *  lost and a fresh tick starts. The guard tracks which tick owns the flag, so the
 *  lost tick settling late does not free it, and the leased claims in
 *  reconcile-queue.ts keep the two ticks off the same rows in the meantime. */
export function startReconcileLoop(
  intervalMs = Number(process.env.RECONCILE_TICK_MS ?? 15_000),
): void {
  if (reconcileTimer) return;
  const watchdogMs = Math.max(intervalMs * 8, 120_000);
  const guard = createTickGuard(watchdogMs);
  reconcileTimer = setInterval(() => {
    const tick = guard.start(Date.now());
    if (!tick) return;
    if (tick.resurrected) {
      console.error(`[reconcile] tick exceeded ${watchdogMs}ms watchdog; starting a fresh tick`);
    }
    void runDueReconciles()
      .catch((err) => console.error("[reconcile] tick failed:", err))
      .finally(() => guard.settle(tick.generation));
  }, intervalMs);
  if (typeof reconcileTimer.unref === "function") reconcileTimer.unref();
}
