import { opencodeHarness } from "../engines/opencode-server";
import type {
  HarnessCheckpoint,
  HarnessReconciliation,
  HarnessSessionHandle,
} from "../engines/types";
import {
  completeRun,
  getLastStepAt,
  listStaleRuns,
  markRunFailed,
  STALE_SUMMARY,
  type StaleRun,
} from "./repo";
import { assertNever } from "../util/exhaustive";

// ---------------------------------------------------------------------------
// Restart recovery (north star Phase 3 "Restart recovery" + Crash Recovery
// Matrix). On boot, a non-terminal run lost its in-memory worker. The old
// behavior failed EVERY such run. This reconciles instead where it can safely,
// through the typed HarnessAdapter seam: an opencode run whose native session
// actually FINISHED server-side (while the backend was down) is marked completed
// with the real assistant answer; anything unreachable/unfinished/ambiguous
// falls back to the honest interrupted summary.
//
// One-SHOT boot pass — no background loops. Each probe is self-bounded and they
// run concurrently, so total boot time is ~one probe budget regardless of how
// many stale runs (or dead sandboxes) there are.
// ---------------------------------------------------------------------------

/** Hard per-run backstop. The harness reconcile bounds its own network work to
 *  ~9s; this race guarantees recoverOne resolves even if that ever leaks. */
const RECONCILE_BUDGET_MS = 11_000;

/** opencode's two adapter ids both run the resident-server path. */
const OPENCODE_ENGINES = new Set(["opencode", "daytona"]);

type RecoverOutcome = "reconciled" | "failed";

export interface RecoveryResult {
  readonly reconciled: number;
  readonly failed: number;
}

/** The native-session probe — the HarnessAdapter.reconcile contract. Defaults to
 *  the opencode harness; a test injects a deterministic fake to exercise the
 *  orchestration without Daytona. */
export type ReconcileProbe = (
  handle: HarnessSessionHandle,
  checkpoint: HarnessCheckpoint,
) => Promise<HarnessReconciliation>;

export async function recoverStaleRuns(
  reconcile: ReconcileProbe = (handle, checkpoint) => opencodeHarness.reconcile(handle, checkpoint),
): Promise<RecoveryResult> {
  const stale = await listStaleRuns();
  if (stale.length === 0) return { reconciled: 0, failed: 0 };

  const outcomes = await Promise.all(stale.map((run) => recoverOne(run, reconcile)));
  return {
    reconciled: outcomes.filter((o) => o === "reconciled").length,
    failed: outcomes.filter((o) => o === "failed").length,
  };
}

/** A RUNNING opencode run that recorded both its native session id and sandbox
 *  id is the only reconcile candidate; everything else (queued, no native
 *  identity, other engines) fails with the honest summary. */
function isReconcileCandidate(
  run: StaleRun,
): run is StaleRun & { engineSessionId: string; sandboxId: string } {
  return (
    run.status === "running" &&
    OPENCODE_ENGINES.has(run.engine) &&
    !!run.engineSessionId &&
    !!run.sandboxId
  );
}

async function recoverOne(run: StaleRun, reconcile: ReconcileProbe): Promise<RecoverOutcome> {
  if (!isReconcileCandidate(run)) {
    await markRunFailed(run.id, STALE_SUMMARY);
    return "failed";
  }

  const lastStepAt = await getLastStepAt(run.id);
  const handle: HarnessSessionHandle = {
    provider: "opencode",
    sessionId: run.engineSessionId,
    sandboxId: run.sandboxId,
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

  // Exhaustive: only a proven completion reconciles; every other status (and any
  // future variant) fails safe with the resumable summary.
  switch (result.status) {
    case "completed": {
      const durationMs = Math.max(0, Date.now() - run.createdAt.getTime());
      await completeRun(run.id, "completed", result.summary, durationMs);
      return "reconciled";
    }
    case "in_progress":
    case "no_change":
    case "unreachable":
    case "unsupported_capability":
      await markRunFailed(run.id, STALE_SUMMARY);
      return "failed";
    default:
      return assertNever(result, "unhandled reconciliation status");
  }
}
