import { opencodeHarness } from "../engines/opencode-server";
import type {
  HarnessCheckpoint,
  HarnessReconciliation,
  HarnessSessionHandle,
} from "../engines/types";
import { getLastStepAt, markRunFailed, STALE_SUMMARY } from "./repo";
import { finalizeRun } from "./finalize";
import {
  failCommandlessStaleRuns,
  listActiveCommands,
  settleCommandForRun,
  type ActiveCommand,
} from "../commands/dispatch";
import { pumpThread } from "../worker";
import { assertNever } from "../util/exhaustive";

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

/** opencode's two adapter ids both run the resident-server path. */
const OPENCODE_ENGINES = new Set(["opencode", "daytona"]);

/** The native-session probe (HarnessAdapter.reconcile). Injectable for tests. */
export type ReconcileProbe = (
  handle: HarnessSessionHandle,
  checkpoint: HarnessCheckpoint,
) => Promise<HarnessReconciliation>;

export interface RecoveryResult {
  readonly reconciled: number;
  readonly failed: number;
  readonly redispatched: number;
}

export async function recoverStaleRuns(
  reconcile: ReconcileProbe = (handle, checkpoint) => opencodeHarness.reconcile(handle, checkpoint),
): Promise<RecoveryResult> {
  const active = await listActiveCommands();

  // Phase 1 — resolve in-flight commands (concurrent; different threads are
  // independent, and a thread has at most one dispatched command).
  const dispatched = active.filter((c) => c.state === "dispatched");
  const resolutions = await Promise.all(dispatched.map((c) => resolveDispatched(c, reconcile)));
  const reconciled = resolutions.filter((r) => r === "reconciled").length;
  let failed = resolutions.filter((r) => r === "failed").length;

  // Phase 2 — pump each distinct thread that had an active command. dispatched
  // ones are now completed/requeued, so a queued head can claim the thread.
  const threads = [...new Set(active.map((c) => c.threadId))];
  const pumped = await Promise.all(threads.map((t) => pumpThread(t)));
  const redispatched = pumped.filter((runId) => runId !== null).length;

  // Phase 3 — fail legacy/orphan non-terminal runs that never joined the lane.
  failed += await failCommandlessStaleRuns(STALE_SUMMARY);

  return { reconciled, failed, redispatched };
}

type DispatchedResolution = "reconciled" | "failed" | "settled";

/** Resolve one dispatched command: reconcile/fail a still-running run, then
 *  settle the command state (completed/requeued) so its thread is freed. */
async function resolveDispatched(
  cmd: ActiveCommand,
  reconcile: ReconcileProbe,
): Promise<DispatchedResolution> {
  let outcome: DispatchedResolution = "settled";
  if (cmd.runStatus === "running") {
    outcome = await recoverRunningRun(cmd, reconcile);
  }
  // The run is now terminal (reconciled/failed) or was already terminal/queued;
  // settle the command to completed (terminal) or requeued (queued).
  await settleCommandForRun(cmd.runId);
  return outcome;
}

async function recoverRunningRun(
  cmd: ActiveCommand,
  reconcile: ReconcileProbe,
): Promise<"reconciled" | "failed"> {
  const candidate =
    OPENCODE_ENGINES.has(cmd.engine) && !!cmd.engineSessionId && !!cmd.sandboxId;
  if (!candidate) {
    await markRunFailed(cmd.runId, STALE_SUMMARY);
    return "failed";
  }

  const lastStepAt = await getLastStepAt(cmd.runId);
  const handle: HarnessSessionHandle = {
    provider: "opencode",
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
    case "unsupported_capability":
      await markRunFailed(cmd.runId, STALE_SUMMARY);
      return "failed";
    default:
      return assertNever(result, "unhandled reconciliation status");
  }
}
