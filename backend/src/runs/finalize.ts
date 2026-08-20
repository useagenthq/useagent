import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { artifacts, runs, type RunStatus } from "../db/schema";
import { completeRun } from "./repo";
import { resolveScopedMemory } from "../memory/scope";
import { enqueueCapture } from "../memory/capture-outbox";
import { collectRunEvidence } from "../memory/capture-evidence";
import { assessCaptureSalience } from "../memory/capture-salience";
import { isInternalRunOrigin } from "./origin";
import { findSlackThreadByRoot } from "../slack/repo";
import { composeSlackReplyText } from "../slack/reply";
import {
  composeAutomationDeliveryText,
  parseSlackAutomationTarget,
  slackChannelAllowed,
} from "../slack/automation";
import { enqueuePostMessageTx, enqueueUploadFileTx, kickSlackOutbox } from "../slack/outbox";
import { slackConfig } from "../env";
import { findScheduleForRun } from "../schedules/repo";
import { publishRunLifecycleChange } from "./org-signals";
import { enqueueCanonicalization } from "./canonicalization-outbox";
import { canonicalEngine } from "../engines/engine-alias";
import { proposeKnowledgeDraftForRun } from "../learning/drafts";

/** Providers whose runs project native events and/or `steps` into the canonical lane.
 *  OpenCode + the ACP engines (acp/claude/codex). Legacy aliases (daytona -> opencode,
 *  claude-sdk -> claude) run the same adapter, so they normalize into this set via
 *  {@link canonicalEngine} and are NOT left silently outside the lane. Only `mock`
 *  (scripted) has no provider source to translate. */
const CANONICAL_ENGINES = new Set(["opencode", "acp", "claude", "codex"]);

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
  let settledThreadId: string | null = null;
  let settledOrgId: string | null = null;
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
    if (!run) return; // deleted mid-flight — nothing to finalize
    settledThreadId = run.threadId;
    settledOrgId = run.orgId;

    // FIRST finalizer wins (completeRun guards on a non-terminal status). A
    // concurrent second finalizer - zombie-cancel racing the reconcile loop -
    // updates zero rows; skip EVERY side-effect so it can never flip the status
    // or double-enqueue a capture for an already-settled run.
    const finalized = await completeRun(runId, status, summary, durationMs, tx);
    if (!finalized) {
      settledThreadId = null;
      settledOrgId = null;
      return;
    }

    // Memory capture — completed runs only, into the run's WRITE pool
    // (personal→personal, org→org), resolved from the run row's memory_scope +
    // authenticated identity. `plan` is null when memory is disabled and
    // `writePool` is null when a personal run failed closed (no auth user) —
    // either way a clean no-op. INTERNAL runs (parity canaries, e2e harnesses —
    // runs.origin, src/runs/origin.ts) never enqueue: evaluation traffic must
    // not pollute org memory. Non-SALIENT summaries (trivial one-liners,
    // apologies, raw command output) are gated out by assessCaptureSalience
    // BEFORE anything durable is written.
    if (status === "completed" && !isInternalRunOrigin(run.origin)) {
      const plan = resolveScopedMemory(run);
      if (plan?.writePool && assessCaptureSalience({ prompt: run.prompt, summary }).salient) {
        // Verified outcome (item 5): capture the structured facts alongside the
        // prose — artifacts published, tool counts, status/duration/engine/model,
        // and the user-correction signal — all readable in THIS transaction.
        const evidence = await collectRunEvidence(run, status, durationMs, tx);
        await enqueueCapture(
          runId,
          plan.writePool.identity,
          { prompt: run.prompt, summary, evidence },
          plan.scope,
          tx,
        );
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

      // Artifact share-back: a Slack-asked run delivers its FILES to the
      // thread, not just prose (the reply text alone strands screenshots and
      // decks in the web app). Newest-first, bounded (5 files, 20MB each -
      // the inbound caps mirrored outward); enqueued in THIS transaction,
      // after the reply row so the summary posts first. Idempotent per
      // (run, artifact), so re-finalizing never re-uploads.
      if (status === "completed") {
        const SHARE_LIMIT = 5;
        const SHARE_MAX_BYTES = 20 * 1024 * 1024;
        const runArtifacts = await tx
          .select({
            id: artifacts.id,
            name: artifacts.name,
            sizeBytes: artifacts.sizeBytes,
          })
          .from(artifacts)
          .where(eq(artifacts.runId, runId))
          .orderBy(desc(artifacts.createdAt))
          .limit(SHARE_LIMIT);
        for (const artifact of runArtifacts) {
          if (artifact.sizeBytes > SHARE_MAX_BYTES) continue;
          const created = await enqueueUploadFileTx(tx, {
            idempotencyKey: `slack-artifact:${runId}:${artifact.id}`,
            channel: slack.channel,
            threadTs: slack.threadTs,
            filename: artifact.name,
            title: artifact.name,
            artifactId: artifact.id,
            size: artifact.sizeBytes,
          });
          kickSlack = kickSlack || created;
        }
      }
    }

    // Automation delivery (delivery.slack) — a run fired by an automation whose
    // delivery config targets Slack posts its terminal outcome to that channel,
    // enqueued in THIS transaction (idempotent per run) so it survives a crash
    // exactly like the thread reply. Both terminal statuses deliver; the
    // allowlist is re-checked at delivery-enqueue time.
    const automation = await findScheduleForRun(runId, tx);
    if (automation) {
      const target = parseSlackAutomationTarget(automation.delivery);
      const config = slackConfig();
      if (target && config && slackChannelAllowed(target.channel, config)) {
        const created = await enqueuePostMessageTx(tx, {
          idempotencyKey: `automation-delivery:${runId}`,
          channel: target.channel,
          text: composeAutomationDeliveryText(automation.name, status, summary),
        });
        kickSlack = kickSlack || created;
      }
    }

    // Canonical lane (final_harness Phase 1): enqueue canonicalization durably IN this
    // transaction, so the intent to translate commits ATOMICALLY with the terminal run
    // - a crash never leaves a settled run with no canonical history. A background
    // outbox worker translates with a source-watermark stability check + retry, and
    // marks `complete` only when the whole source was translated. OpenCode + the ACP
    // engines project into `steps`, which the step lane turns into canonical tool rows.
    if (CANONICAL_ENGINES.has(canonicalEngine(run.engine))) {
      await enqueueCanonicalization(runId, run.threadId, tx);
    }
  });

  // Kick the relay AFTER commit (the row isn't visible to it until then). No-op
  // when Slack isn't configured (the relay isn't running).
  if (kickSlack) kickSlackOutbox();

  // Post-commit thread signal: the run reached a terminal state, so wake any
  // connected thread stream to re-project it (final status + summary). The
  // per-run `end` bus already settles the run's transient text on the stream;
  // this carries the durable summary the `done` frame does not. Skipped when the
  // run was deleted mid-flight (settledThreadId stays null).
  if (settledThreadId && settledOrgId) {
    publishRunLifecycleChange({
      orgId: settledOrgId,
      threadId: settledThreadId,
      runId,
      kind: "settled",
    });
  }

  // Learning lane (item 4), post-commit + best-effort: a completed HIGH-VALUE
  // run proposes a reviewable knowledge DRAFT (never a knowledge record —
  // publishing is org-admin-gated). Idempotent per run, and a failure here must
  // never affect the already-finalized run.
  if (status === "completed" && settledOrgId) {
    try {
      await proposeKnowledgeDraftForRun(runId);
    } catch (err) {
      console.error("[learning] draft proposal failed:", (err as Error).message);
    }
  }
}
