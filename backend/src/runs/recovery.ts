import { resolveHarness } from "../engines";
import type {
  HarnessCheckpoint,
  HarnessInterimEvent,
  HarnessReconciliation,
  HarnessSessionHandle,
} from "../engines/types";
import { getLastStepAt, getRun, STALE_SUMMARY } from "./repo";
import { finalizeRun } from "./finalize";
import { recordProviderEvent } from "./provider-events";
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

/** The event type for the durable "reconciling after restart" marker. Distinct
 *  from the terminal events so the timeline can show a run is being re-probed. */
export const RUN_RECONCILING = "run.reconciling";

// ---------------------------------------------------------------------------
// Restart recovery of the durable command lane (north star Phase 3 "Restart
// recovery" + Crash Recovery Matrix). On boot the in-memory workers are gone,
// so the mailbox on the `commands` table is the source of truth. Three phases:
//
//  1. RESOLVE each in-flight (dispatched) command against its run:
//       running  → reconcile the native session (completed) or fail honestly,
//                  then mark the command completed;
//       terminal → mark the command completed (crash between run-done and the
//                  command settle — Crash Matrix "provider completed while Skynet
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

/** OpenCode's two adapter ids run the legacy resident-server path. */
const OPENCODE_ENGINES = new Set(["opencode", "daytona"]);
const RUNTIME_SESSION_PREFIX = "skynet-thread-";

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
): Promise<RecoveryResult> {
  const active = await listActiveCommands();

  // Phase 1 — resolve in-flight commands (concurrent; different threads are
  // independent, and a thread has at most one dispatched command).
  const dispatched = active.filter((c) => c.state === "dispatched");
  const resolutions = await Promise.all(dispatched.map((c) => resolveDispatched(c, reconcile)));
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
): Promise<DispatchedResolution> {
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
  const runtimeSession = cmd.engineSessionId?.startsWith(RUNTIME_SESSION_PREFIX) ?? false;
  const candidate =
    !!cmd.engineSessionId &&
    !!cmd.sandboxId &&
    (runtimeSession || OPENCODE_ENGINES.has(cmd.engine));
  if (!candidate) {
    await finalizeRun(cmd.runId, "failed", STALE_SUMMARY, 0);
    return "failed";
  }

  const lastStepAt = await getLastStepAt(cmd.runId);
  const handle: HarnessSessionHandle = {
    provider: cmd.engine === "daytona" ? "opencode" : cmd.engine,
    sessionId: cmd.engineSessionId!,
    sandboxId: cmd.sandboxId!,
  };

  let result: HarnessReconciliation;
  try {
    result = await Promise.race([
      reconcile(handle, { sinceMs: lastStepAt?.getTime() ?? 0 }),
      new Promise<HarnessReconciliation>((resolve) =>
        setTimeout(() => resolve({ status: "unreachable" }), RECONCILE_BUDGET_MS),
      ),
    ]);
  } catch {
    result = { status: "unreachable" };
  }

  switch (result.status) {
    case "completed":
      // Finalize like a live completion: commits `completed` AND enqueues the
      // durable memory capture in one transaction, so a boot-reconciled run
      // captures to team memory exactly like a run that finished normally.
      await finalizeRun(cmd.runId, "completed", result.summary, 0);
      return "reconciled";
    case "in_progress":
    case "no_change":
    case "unreachable":
    case "unsupported_capability": {
      // ADAPTIVE (#63): the sandbox session may still be finishing after a fast
      // restart. Instead of honest-failing NOW, PARK for a bounded background
      // re-probe (the run stays `running`). enqueue is idempotent, so a re-boot
      // re-parks against the ORIGINAL deadline. A freshly parked run gets the
      // "reconciling" marker; a non-candidate already failed above.
      const now = Date.now();
      const newlyParked = await enqueueReconcile({
        runId: cmd.runId,
        threadId: cmd.threadId,
        sandboxId: cmd.sandboxId!,
        sessionId: cmd.engineSessionId!,
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
      return "parked";
    }
    default:
      return assertNever(result, "unhandled reconciliation status");
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

/** Append the interim native events a re-probe surfaced to the canonical run, so
 *  SSE subscribers watch the timeline advance while the run is being adopted.
 *  Idempotent: recordProviderEvent upserts on the stable provider event id
 *  (opencode `pe_<partId>`), the SAME key the live lane uses, so re-probes and the
 *  pre-restart lane never create a duplicate row. Payloads are redacted like the
 *  live lane. Returns the number ingested this probe. Never throws. */
async function ingestInterimEvents(
  entry: ReconcileEntry,
  orgId: string | null,
  events: readonly HarnessInterimEvent[],
): Promise<number> {
  const redact = await orgSecretRedactor(orgId);
  let recovered = 0;
  for (const ev of events) {
    try {
      await recordProviderEvent({
        id: ev.id,
        runId: entry.runId,
        threadId: entry.threadId,
        provider: ev.provider,
        eventType: ev.eventType,
        nativeSessionId: ev.sessionId ?? null,
        nativeMessageId: ev.messageId ?? null,
        nativePartId: ev.partId ?? null,
        nativeCallId: ev.callId ?? null,
        payload: redact.unknown(ev.payload),
      });
      recovered++;
    } catch {
      /* a single malformed event must never abort the probe */
    }
  }
  return recovered;
}

// ---------------------------------------------------------------------------
// Adaptive background reconcile loop (#63). Re-probes parked runs on a short
// backoff within their budget: adopt the finished session, honest-fail after the
// deadline, else reschedule. Single-flight (one tick at a time) — single-replica
// scope, so no row locking. Never throws; a tick error is logged.
// ---------------------------------------------------------------------------

/** One reconcile tick: process every DUE parked run. Returns counts for
 *  tests/telemetry. The probe is injectable (tests). Never throws. */
export async function runDueReconciles(
  reconcile: ReconcileProbe = defaultReconcile,
): Promise<{ adopted: number; failed: number; retried: number; dropped: number; eventsRecovered: number }> {
  const due = await claimDueReconciles();
  let adopted = 0;
  let failed = 0;
  let retried = 0;
  let dropped = 0;
  let eventsRecovered = 0;
  for (const entry of due) {
    // NO-DOUBLE-ADOPT: if the run already settled via another lane (a reply's
    // worker took the thread, a cancel, a prior tick), just drop the parked row.
    const run = await getRun(entry.runId);
    if (!run || run.status !== "running") {
      await deleteReconcile(entry.runId);
      dropped++;
      continue;
    }
    const result = await probeParked(entry, reconcile);
    // CONTINUITY (#63): while the run is still parked and its session is reachable
    // and generating, ingest the interim native events so the timeline advances
    // during adoption instead of freezing. Idempotent across probes (upsert on the
    // live-lane part id). A provider that can't surface interim events (ACP) just
    // returns none — today's frozen-marker behavior, no faked progress.
    const recovered =
      result.status === "in_progress" && result.events?.length
        ? await ingestInterimEvents(entry, run.orgId, result.events)
        : 0;
    eventsRecovered += recovered;
    const action = nextReconcileAction(result.status === "completed", Date.now(), entry.deadlineMs);
    if (action === "adopt") {
      await finalizeRun(entry.runId, "completed", (result as { summary: string }).summary, 0);
      await settleAndPump(entry.runId, entry.threadId);
      await deleteReconcile(entry.runId);
      adopted++;
    } else if (action === "fail") {
      await finalizeRun(entry.runId, "failed", STALE_SUMMARY, 0);
      await settleAndPump(entry.runId, entry.threadId);
      await deleteReconcile(entry.runId);
      failed++;
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
      await bumpReconcile(entry.runId, reconcileBackoffAt(Date.now(), entry.attempts));
      retried++;
    }
  }
  return { adopted, failed, retried, dropped, eventsRecovered };
}

/** Bounded native-session re-probe for one parked entry. Never throws. */
async function probeParked(entry: ReconcileEntry, reconcile: ReconcileProbe): Promise<HarnessReconciliation> {
  const handle: HarnessSessionHandle = {
    provider: "opencode",
    sessionId: entry.sessionId,
    sandboxId: entry.sandboxId,
  };
  try {
    return await Promise.race([
      reconcile(handle, { sinceMs: entry.sinceMs }),
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
let reconcileTicking = false;

/** Start the adaptive reconcile loop (idempotent). Single-flight: a slow tick is
 *  never overlapped by the next. `RECONCILE_TICK_MS` overrides the interval
 *  (tests go fast). Best-effort — a tick failure is logged, never thrown. */
export function startReconcileLoop(
  intervalMs = Number(process.env.RECONCILE_TICK_MS ?? 15_000),
): void {
  if (reconcileTimer) return;
  reconcileTimer = setInterval(() => {
    if (reconcileTicking) return;
    reconcileTicking = true;
    void runDueReconciles()
      .catch((err) => console.error("[reconcile] tick failed:", err))
      .finally(() => {
        reconcileTicking = false;
      });
  }, intervalMs);
  if (typeof reconcileTimer.unref === "function") reconcileTimer.unref();
}
