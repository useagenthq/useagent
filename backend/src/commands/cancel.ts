import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { commands, runs, type RunStatus } from "../db/schema";
import { isUniqueViolation } from "../db/pg-errors";
import { completeRun } from "../runs/repo";
import { publishRunLifecycleChange } from "../runs/org-signals";
import { RUN_CANCEL, RUN_CREATE } from "./repo";

// ---------------------------------------------------------------------------
// Durable run cancellation (north star "Durable Commands"). A user Stop enters
// through a `run.cancel` command — the durable, idempotent record of the intent
// — exactly like `run.create`. The command is written already-`completed`
// (its action is a one-shot signal, not a queued turn), so a crash can NEVER
// leave a cancel command stuck in the mailbox.
//
// The actual stop is split by the run's state at accept time, both handled here
// atomically or by the caller:
//   - QUEUED: the run never started, so we fail it AND settle its `run.create`
//     command IN THE SAME TRANSACTION — the boot reconciler can then never
//     re-dispatch a cancelled turn.
//   - RUNNING: an actor is live in this process; the caller signals its
//     AbortController (worker.signalCancel), whose teardown finalizes the run
//     "Stopped by user" and pumps the thread. If the process died first, the
//     existing run.create recovery fails the orphaned run on boot.
// ---------------------------------------------------------------------------

/** Honest terminal summary for a user-initiated cancel. */
export const CANCEL_SUMMARY = "Stopped by user";

/** Synthetic per-run idempotency key so a repeated Stop is a no-op replay. */
export const cancelKey = (runId: string): string => `cancel:${runId}`;

export type CancelOutcome =
  /** Cancel newly recorded. `runStatusWas` tells the caller whether to signal a
   *  live actor (running) or just advance the thread (queued, already failed). */
  | { readonly status: "accepted"; readonly runStatusWas: RunStatus; readonly threadId: string }
  /** A cancel was already recorded for this run — idempotent replay. */
  | { readonly status: "already"; readonly threadId: string }
  /** No such run in this org. */
  | { readonly status: "not_found" }
  /** The run already settled — nothing to cancel. */
  | { readonly status: "terminal"; readonly runStatus: RunStatus };

/**
 * Accept a durable `run.cancel` for a run, org-scoped. Idempotent by
 * `cancel:<runId>`. Fails a not-yet-started (queued) run in the same
 * transaction; a running run is left for the caller to signal.
 */
export async function acceptRunCancel(input: {
  orgId: string;
  actorId: string | null;
  runId: string;
}): Promise<CancelOutcome> {
  // Fast idempotency path (outside any tx): a prior Stop short-circuits. Catching
  // the unique violation INSIDE the tx would poison it (an aborted tx can't be
  // continued), so — like acceptRunCommand — we pre-check and also catch the
  // concurrent-race violation OUTSIDE the tx, where drizzle's wrapped error is
  // still recognized (soak DEFECT-1).
  const prior = await findCancel(input.orgId, input.runId);
  if (prior) return { status: "already", threadId: prior };

  try {
    // A queued run failed in-tx never reaches finalizeRun (it has no live actor),
    // so the thread stream would not otherwise learn it settled without a worker
    // step. Capture the thread of such a cancel and signal AFTER commit.
    let queuedCancelledThreadId: string | null = null;
    const outcome = await db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, input.runId), eq(runs.orgId, input.orgId)))
        .limit(1);
      if (!run) return { status: "not_found" as const };
      if (run.status === "completed" || run.status === "failed") {
        return { status: "terminal" as const, runStatus: run.status };
      }

      // Durable intent record, written already-completed (never stuck).
      await tx.insert(commands).values({
        id: crypto.randomUUID(),
        idempotencyKey: cancelKey(input.runId),
        orgId: input.orgId,
        actorId: input.actorId,
        kind: RUN_CANCEL,
        runId: input.runId,
        threadId: run.threadId,
        payloadFingerprint: null,
        payload: null,
        state: "completed",
        attemptCount: 0,
      });

      // A queued run has no live actor to signal: fail it and settle its
      // run.create command here so recovery/pump can't resurrect it.
      if (run.status === "queued") {
        await completeRun(input.runId, "failed", CANCEL_SUMMARY, 0, tx);
        await tx.execute(sql`
          update commands set state = 'completed', updated_at = now()
          where run_id = ${input.runId} and kind = ${RUN_CREATE} and state <> 'completed'`);
        queuedCancelledThreadId = run.threadId;
      }

      return { status: "accepted" as const, runStatusWas: run.status, threadId: run.threadId };
    });

    // Post-commit thread signal (queued-cancel only): the run went failed with no
    // worker step, so wake the thread stream to re-project it. A RUNNING cancel is
    // finalized by the actor's teardown, which signals `settled` itself.
    if (queuedCancelledThreadId) {
      publishRunLifecycleChange({
        orgId: input.orgId,
        threadId: queuedCancelledThreadId,
        runId: input.runId,
        kind: "cancelled",
      });
    }
    return outcome;
  } catch (err) {
    // A concurrent Stop won the unique index; the tx rolled back — resolve as replay.
    if (isUniqueViolation(err)) {
      const thread = await findCancel(input.orgId, input.runId);
      if (thread) return { status: "already", threadId: thread };
    }
    throw err;
  }
}

/** The thread of an existing run.cancel for this run, or null. */
async function findCancel(orgId: string, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ threadId: commands.threadId })
    .from(commands)
    .where(and(eq(commands.orgId, orgId), eq(commands.idempotencyKey, cancelKey(runId))))
    .limit(1);
  return row ? (row.threadId ?? "") : null;
}
