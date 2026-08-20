import { desc, eq } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { artifacts, runs, type RunStatus } from "../db/schema";
import { completeRun } from "./repo";
import { resolveScopedMemory } from "../memory/scope";
import { enqueueCapture } from "../memory/capture-outbox";
import { collectRunEvidence } from "../memory/capture-evidence";
import { assessCaptureSalience } from "../memory/capture-salience";
import { isInternalRunOrigin } from "./origin";
import { findSlackRunResponse } from "../slack/repo";
import { composeSlackReplyText } from "../slack/reply";
import { buildRunCard, deriveTitle, phaseForStatus, sessionUrl } from "../slack/card";
import { parseRepoRef } from "../github/repo-ref";
import {
  composeAutomationDeliveryText,
  parseSlackAutomationTarget,
  slackChannelAllowed,
} from "../slack/automation";
import {
  enqueuePostMessageTx,
  enqueueSessionStatusTx,
  enqueueStopStreamTx,
  enqueueUploadFileTx,
  kickSlackOutbox,
} from "../slack/outbox";
import { terminalStreamChunks } from "../slack/streaming";
import { env, slackConfig } from "../env";
import { findScheduleForRun } from "../schedules/repo";
import { publishRunLifecycleChange } from "./org-signals";
import { enqueueCanonicalization } from "./canonicalization-outbox";
import { canonicalEngine } from "../engines/engine-alias";
import { enqueueLearning } from "../learning/learning-outbox";

/** Providers whose runs project native events and/or `steps` into the canonical lane.
 *  OpenCode + the ACP engines (acp/claude/codex). Legacy aliases (daytona -> opencode,
 *  claude-sdk -> claude) run the same adapter, so they normalize into this set via
 *  {@link canonicalEngine} and are NOT left silently outside the lane. Only `mock`
 *  (scripted) has no provider source to translate. */
const CANONICAL_ENGINES = new Set(["opencode", "acp", "claude", "codex"]);

type RunRow = typeof runs.$inferSelect;

export async function enqueueSlackTerminalDeliveryForRunTx(
  tx: Executor,
  run: RunRow,
  status: RunStatus,
  summary: string,
): Promise<boolean> {
  const slack = await findSlackRunResponse(run.id, tx);
  if (!slack) return false;

  const finalCard = buildRunCard({
    title: deriveTitle(run.prompt),
    phase: phaseForStatus(status),
    model: run.model,
    repoSpecs: run.repos.map(parseRepoRef),
    webUrl: sessionUrl(env.FRONTEND_ORIGIN, run.threadId),
    answer: summary,
  });
  const replyText = composeSlackReplyText(status, summary);
  let kickSlack = await enqueueStopStreamTx(tx, {
    idempotencyKey: `slack-reply:${slack.teamId}:${run.id}`,
    teamId: slack.teamId,
    channel: slack.channel,
    threadTs: slack.threadTs,
    runId: run.id,
    chunks: terminalStreamChunks({ phase: phaseForStatus(status), answerText: replyText }),
    blocks: finalCard.blocks,
    text: finalCard.text,
    fallbackText: replyText,
  });
  const statusCreated = await enqueueSessionStatusTx(tx, {
    idempotencyKey: `slack-status:final:${slack.teamId}:${run.id}`,
    teamId: slack.teamId,
    channel: slack.channel,
    threadTs: slack.threadTs,
    status: "active",
  });
  kickSlack = kickSlack || statusCreated;

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
      .where(eq(artifacts.runId, run.id))
      .orderBy(desc(artifacts.createdAt))
      .limit(SHARE_LIMIT);
    for (const artifact of runArtifacts) {
      if (artifact.sizeBytes > SHARE_MAX_BYTES) continue;
      const created = await enqueueUploadFileTx(tx, {
        idempotencyKey: `slack-artifact:${slack.teamId}:${run.id}:${artifact.id}`,
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

  return kickSlack;
}

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
 * is configured), the Slack reply (Slack-originated runs, both terminal
 * statuses), canonicalization, and the LEARNING intent (completed non-internal
 * runs - self_improving 6.1). Replaces the bare terminal-status update on every
 * terminal path (worker success/failure/mock, boot reconcile/fail). Safe to call
 * more than once - the run update is a plain UPDATE and every enqueue is idempotent.
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
    kickSlack = (await enqueueSlackTerminalDeliveryForRunTx(tx, run, status, summary)) || kickSlack;

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

    // Learning intent (self_improving 6.1): a completed, non-internal run
    // enqueues its DURABLE learning intent IN this transaction, replacing the
    // old post-commit proposeKnowledgeDraftForRun call (which left a crash
    // window between the commit and the draft). A boot-started worker
    // (learning-outbox.ts) builds the evidence-backed candidate off this
    // committed row - retryable, dead-lettering, and it NEVER fails the run.
    // INTERNAL runs (parity canaries, e2e/soak harnesses - runs.origin) are
    // excluded so evaluation traffic never becomes org learning. The verified-
    // outcome gate (6.4) still runs at build time, so an unverified completion
    // enqueues an intent but produces no candidate (a clean skip).
    if (status === "completed" && run.orgId && !isInternalRunOrigin(run.origin)) {
      await enqueueLearning(
        {
          runId,
          orgId: run.orgId,
          userId: run.userId,
          memoryScope: run.memoryScope,
          origin: run.origin,
        },
        tx,
      );
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
}
