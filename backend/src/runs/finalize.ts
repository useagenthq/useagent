import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { runs, type RunStatus } from "../db/schema";
import { completeRun } from "./repo";
import { resolveMemoryIdentity } from "../memory/team-memory";
import { enqueueCapture } from "../memory/capture-outbox";

// ---------------------------------------------------------------------------
// Run finalization — the ONE place a run reaches a terminal state, so the
// terminal-status commit and every DURABLE side-effect it triggers happen in a
// SINGLE transaction (north star "Transaction Boundaries").
//
// GAP 2 fix: memory capture used to be enqueued AFTER completeRun, in a separate
// statement — a crash in that gap left a `completed` run with no capture row, and
// NOTHING re-enqueued it (recovery only settles the command). Worse, the boot
// RECONCILE path (recovery.ts → completeRun) and the mock path never enqueued at
// all. Folding the enqueue into the completion transaction closes both: EVERY
// completed run — engine, mock, or boot-reconciled — durably enqueues its capture
// exactly once (idempotent by runId), atomically with reaching `completed`.
//
// A failure to enqueue would roll the whole transaction back (the run would not be
// marked completed and the worker/recovery would retry), so the invariant is
// "completed ⇒ capture enqueued", never one without the other.
// ---------------------------------------------------------------------------

/**
 * Commit a run's terminal status + summary and, in the SAME transaction, enqueue
 * its durable side-effects. Memory capture is enqueued for every `completed` run
 * when team memory is configured (idempotent by runId); nothing is enqueued for a
 * `failed` run here. Replaces bare `completeRun` on every terminal path (worker
 * success/mock, boot reconcile). Safe to call more than once — the run update is
 * a plain UPDATE and the capture enqueue is idempotent.
 */
export async function finalizeRun(
  runId: string,
  status: RunStatus,
  summary: string,
  durationMs: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
    if (!run) return; // deleted mid-flight — nothing to finalize

    await completeRun(runId, status, summary, durationMs, tx);

    if (status === "completed") {
      // Team memory is a shared per-team pool; identity is null when memory is
      // disabled (MEMORY_API_URL unset), so this no-ops cleanly in that case.
      const identity = resolveMemoryIdentity(run);
      if (identity) {
        await enqueueCapture(runId, identity, { prompt: run.prompt, summary }, tx);
      }
    }
  });
}
