import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { runs, type RunStatus } from "../db/schema";
import { completeRun } from "./repo";
import { resolveMemoryIdentity } from "../memory/team-memory";
import { enqueueCapture } from "../memory/capture-outbox";
import { findSlackThreadByRoot } from "../slack/repo";
import { composeSlackReplyText } from "../slack/reply";
import { enqueuePostMessageTx, kickSlackOutbox } from "../slack/outbox";

// ---------------------------------------------------------------------------
// Run finalization — the ONE place a run reaches a terminal state, so the
// terminal-status commit and every DURABLE side-effect it triggers happen in a
// SINGLE transaction (north star "Transaction Boundaries").
//
// GAP 2 (memory capture): the capture used to be enqueued AFTER completeRun — a
// crash in that gap left a `completed` run with no capture, and the boot-reconcile
// + mock paths never enqueued at all. Folding it into the completion transaction
// makes "completed ⇒ capture enqueued" hold for EVERY completed run.
//
// GAP 3 (slack reply): the final Slack reply used to be enqueued by an in-process
// watcher that did NOT survive a restart (a boot-reconciled Slack run never
// replied) and fired AFTER completeRun (a crash in that gap lost the reply). It
// now enqueues here, in the finalization transaction, for BOTH terminal statuses,
// so a Slack-originated run's reply is durable and survives a crash/restart.
// Idempotent by `slack-reply:<runId>`, so re-finalizing never double-posts.
//
// A failure to enqueue rolls the whole transaction back (the run stays
// non-terminal and is retried), so a run is never marked terminal without its
// side-effects committed alongside.
// ---------------------------------------------------------------------------

/**
 * Commit a run's terminal status + summary and, in the SAME transaction, enqueue
 * its durable side-effects: the memory capture (completed runs, when team memory
 * is configured) and the Slack reply (Slack-originated runs, both terminal
 * statuses). Replaces the bare terminal-status update on every terminal path
 * (worker success/failure/mock, boot reconcile/fail). Safe to call more than once
 * — the run update is a plain UPDATE and both enqueues are idempotent.
 */
export async function finalizeRun(
  runId: string,
  status: RunStatus,
  summary: string,
  durationMs: number,
): Promise<void> {
  let kickSlack = false;
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
    if (!run) return; // deleted mid-flight — nothing to finalize

    await completeRun(runId, status, summary, durationMs, tx);

    // Memory capture — completed runs only, when team memory is configured
    // (identity is null when MEMORY_API_URL is unset → clean no-op).
    if (status === "completed") {
      const identity = resolveMemoryIdentity(run);
      if (identity) {
        await enqueueCapture(runId, identity, { prompt: run.prompt, summary }, tx);
      }
    }

    // Slack reply — durable for a Slack-originated run (resolved from the run's
    // thread, so replies + boot-reconciled runs both find it). Non-Slack runs
    // resolve null and enqueue nothing.
    const slack = await findSlackThreadByRoot(run.threadId, tx);
    if (slack) {
      kickSlack = await enqueuePostMessageTx(tx, {
        idempotencyKey: `slack-reply:${runId}`,
        channel: slack.channel,
        text: composeSlackReplyText(status, summary),
        threadTs: slack.threadTs,
      });
    }
  });

  // Kick the relay AFTER commit (the row isn't visible to it until then). No-op
  // when Slack isn't configured (the relay isn't running).
  if (kickSlack) kickSlackOutbox();
}
