import { reconcileOpencodeRun, type OpencodeReconcile } from "../engines/opencode-server";
import {
  completeRun,
  getLastStepAt,
  listStaleRuns,
  markRunFailed,
  STALE_SUMMARY,
  type StaleRun,
} from "./repo";

// ---------------------------------------------------------------------------
// Restart recovery (north star Phase 3 "Restart recovery" + Crash Recovery
// Matrix). On boot, a non-terminal run lost its in-memory worker. The old
// behavior failed EVERY such run. This reconciles instead where it can safely:
// an opencode run whose native session actually FINISHED server-side (while the
// backend was down) is marked completed with the real assistant answer; anything
// unreachable/unfinished/ambiguous falls back to the honest interrupted summary.
//
// This is a ONE-SHOT boot pass — no background loops. Each probe is self-bounded
// and they run concurrently, so total boot time is ~one probe budget regardless
// of how many stale runs (or dead sandboxes) there are.
// ---------------------------------------------------------------------------

/** Hard per-run backstop. reconcileOpencodeRun bounds its own network work to
 *  ~9s; this race guarantees recoverOne resolves even if that ever leaks. */
const RECONCILE_BUDGET_MS = 11_000;

/** opencode's two adapter ids both run the resident-server path. */
const OPENCODE_ENGINES = new Set(["opencode", "daytona"]);

export interface RecoveryResult {
  reconciled: number;
  failed: number;
}

/** The native-session probe. Defaults to the real opencode reconciler; a test
 *  injects a deterministic fake to exercise the orchestration without Daytona. */
export type ReconcileFn = (input: {
  sandboxId: string;
  sessionId: string;
  sinceMs: number;
}) => Promise<OpencodeReconcile>;

export async function recoverStaleRuns(
  reconcile: ReconcileFn = reconcileOpencodeRun,
): Promise<RecoveryResult> {
  const stale = await listStaleRuns();
  if (stale.length === 0) return { reconciled: 0, failed: 0 };

  const outcomes = await Promise.all(stale.map((run) => recoverOne(run, reconcile)));
  return {
    reconciled: outcomes.filter((o) => o === "reconciled").length,
    failed: outcomes.filter((o) => o === "failed").length,
  };
}

async function recoverOne(
  run: StaleRun,
  reconcile: ReconcileFn,
): Promise<"reconciled" | "failed"> {
  // Only a RUNNING opencode run that recorded both its native session id and
  // sandbox id is a reconcile candidate. Everything else (queued, no native
  // identity, other engines) fails with the honest summary.
  const probeable =
    run.status === "running" &&
    OPENCODE_ENGINES.has(run.engine) &&
    !!run.engineSessionId &&
    !!run.sandboxId;
  if (!probeable) {
    await markRunFailed(run.id, STALE_SUMMARY);
    return "failed";
  }

  const lastStepAt = await getLastStepAt(run.id);
  let rec: OpencodeReconcile;
  try {
    rec = await Promise.race([
      reconcile({
        sandboxId: run.sandboxId!,
        sessionId: run.engineSessionId!,
        sinceMs: lastStepAt?.getTime() ?? 0,
      }),
      new Promise<OpencodeReconcile>((resolve) =>
        setTimeout(() => resolve({ outcome: "unreachable" }), RECONCILE_BUDGET_MS),
      ),
    ]);
  } catch {
    rec = { outcome: "unreachable" };
  }

  if (rec.outcome === "completed") {
    const durationMs = Math.max(0, Date.now() - run.createdAt.getTime());
    await completeRun(run.id, "completed", rec.summary, durationMs);
    return "reconciled";
  }

  // unreachable | in_progress | no_new_message → when in doubt, fail with the
  // resumable summary rather than claim a completion we cannot prove.
  await markRunFailed(run.id, STALE_SUMMARY);
  return "failed";
}
