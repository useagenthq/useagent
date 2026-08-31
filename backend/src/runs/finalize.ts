import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { artifacts, providerEvents, runs, steps, type RunStatus } from "../db/schema";
import { completeRun } from "./repo";
import { resolveScopedMemory } from "../memory/scope";
import { enqueueCapture } from "../memory/capture-outbox";
import { collectRunEvidence } from "../memory/capture-evidence";
import { assessCaptureSalience } from "../memory/capture-salience";
import { isInternalRunOrigin } from "./origin";
import { recordRunFollowups } from "./followups";
import {
  createSlackRunResponse,
  findSlackRunResponse,
  findSlackThreadByRoot,
} from "../slack/repo";
import { composeSlackReplyText } from "../slack/reply";
import { buildRunCard, deriveTitle, phaseForStatus, sessionUrl } from "../slack/card";
import { parseRepoRef } from "../github/repo-ref";
import {
  composeAutomationDeliveryText,
  resolveSlackAutomationTargetForOrg,
} from "../slack/automation";
import {
  enqueuePostMessageTx,
  enqueueSessionStatusTx,
  enqueueStopStreamTx,
  enqueueThreadStatusTx,
  enqueueUploadFileTx,
  kickSlackOutbox,
  slackArtifactDeliveryIdempotencyKey,
} from "../slack/outbox";
import {
  composeStreamClosing,
  directMessageChannel,
  STREAM_NARRATION_CAP,
  terminalTaskChunks,
} from "../slack/streaming";
import { turnStream } from "./turn-stream";
import { env } from "../env";
import { findScheduleForRun } from "../schedules/repo";
import { publishRunLifecycleChange } from "./org-signals";
import { enqueueCanonicalization } from "./canonicalization-outbox";
import { canonicalEngine } from "../engines/engine-alias";
import { enqueueLearning } from "../learning/learning-outbox";
import { releaseLeaseForRun } from "../fleet/lease-repo";
import { executionGraphRolloutMode } from "./execution-graph-rollout";
import {
  prepareExecutionGraphSeal,
  sealExecutionGraphAfterFinalizeTx,
} from "./execution-graph-seal";
import { evaluateFinishedWork, finishedWorkFailureSummary } from "./finished-work";
import { listFinishedWorkForRun } from "./finished-work-repo";
import { finishedWorkEnforcementEnabled, finishedWorkRolloutMode } from "./finished-work-rollout";
import { lockFinishedWorkRun } from "./finished-work-lock";

/** Providers whose runs project native events and/or `steps` into the canonical lane.
 *  OpenCode, Pi, and the ACP engines (acp/claude/codex). Legacy aliases (daytona -> opencode,
 *  claude-sdk -> claude) run the same adapter, so they normalize into this set via
 *  {@link canonicalEngine} and are NOT left silently outside the lane. Only `mock`
 *  (scripted) has no provider source to translate. */
const CANONICAL_ENGINES = new Set(["opencode", "acp", "claude", "codex", "pi"]);

export function terminalCanonicalizationEligible(engine: string): boolean {
  return CANONICAL_ENGINES.has(canonicalEngine(engine));
}

type RunRow = typeof runs.$inferSelect;

export async function enqueueSlackTerminalDeliveryForRunTx(
  tx: Executor,
  run: RunRow,
  status: RunStatus,
  summary: string,
): Promise<boolean> {
  const thread = run.orgId
    ? await findSlackThreadByRoot(run.threadId, tx, run.orgId)
    : null;
  let slack = await findSlackRunResponse(run.id, tx);
  if (
    slack &&
    (!thread || slack.teamId !== thread.teamId || slack.channel !== thread.channel || slack.threadTs !== thread.threadTs)
  ) {
    slack = null;
  }
  if (!slack && thread) {
    await createSlackRunResponse({ runId: run.id, ...thread }, tx);
    slack = await findSlackRunResponse(run.id, tx);
  }
  if (
    slack &&
    (!thread || slack.teamId !== thread.teamId || slack.channel !== thread.channel || slack.threadTs !== thread.threadTs)
  ) {
    slack = null;
  }
  if (!slack) return false;
  if (!run.orgId) return false;

  const title = deriveTitle(run.prompt);
  const phase = phaseForStatus(status);
  const webUrl = sessionUrl(env.FRONTEND_ORIGIN, run.threadId);
  const repoSpecs = run.repos.map(parseRepoRef);
  // Two final cards: the FULL card (answer section) advances the Block Kit
  // fallback message in place; the CHROME card (linked title + context +
  // button, no answer) closes the native stream, whose body carries the reply.
  const finalCard = buildRunCard({ title, phase, model: run.model, repoSpecs, webUrl, answer: summary });
  const chromeCard = buildRunCard({ title, phase, model: run.model, repoSpecs, webUrl, answer: summary, omitAnswer: true });
  const replyText = composeSlackReplyText(status, summary);

  // The last started tool task settles alongside the root task at stop.
  const [lastStep] = await tx
    .select({ id: steps.id, label: steps.label })
    .from(steps)
    .where(and(eq(steps.runId, run.id), ne(steps.kind, "done")))
    .orderBy(desc(steps.idx))
    .limit(1);

  // Narration the live watcher streamed into the message body (process-local
  // buffer; empty after a restart). The stop delivery appends exactly the tail
  // the stream has not accepted yet, then the closing markdown.
  const narration = (turnStream.snapshot(run.id) ?? "").slice(0, STREAM_NARRATION_CAP);
  const closingMarkdown = composeStreamClosing({
    status: status === "failed" ? "failed" : "completed",
    summary,
    narration,
  });

  let kickSlack = await enqueueStopStreamTx(tx, {
    idempotencyKey: `slack-reply:${slack.teamId}:${run.id}`,
    orgId: run.orgId,
    teamId: slack.teamId,
    channel: slack.channel,
    threadTs: slack.threadTs,
    runId: run.id,
    chunks: terminalTaskChunks({ phase, title, lastStep: lastStep ?? null }),
    narrationText: narration,
    closingMarkdown,
    blocks: chromeCard.blocks,
    text: finalCard.text,
    fallbackBlocks: finalCard.blocks,
    fallbackText: replyText,
  });
  const statusCreated = await enqueueSessionStatusTx(tx, {
    idempotencyKey: `slack-status:final:${slack.teamId}:${run.id}`,
    orgId: run.orgId,
    teamId: slack.teamId,
    channel: slack.channel,
    threadTs: slack.threadTs,
    runId: run.id,
    status: "active",
  });
  kickSlack = kickSlack || statusCreated;
  // DM threads: clear the free-text working shimmer durably (the in-process
  // watcher also clears it, but only this survives a restart).
  if (directMessageChannel(slack.channel)) {
    const shimmerCleared = await enqueueThreadStatusTx(tx, {
      idempotencyKey: `slack-thread-status:final:${slack.teamId}:${run.id}`,
      orgId: run.orgId,
      teamId: slack.teamId,
      channel: slack.channel,
      threadTs: slack.threadTs,
      runId: run.id,
      status: "",
    });
    kickSlack = kickSlack || shimmerCleared;
  }

  if (status === "completed") {
    const SHARE_LIMIT = 5;
    const SHARE_MAX_BYTES = 20 * 1024 * 1024;
    const revisedEvents = await tx
      .select({ payload: providerEvents.payload })
      .from(providerEvents)
      .where(and(eq(providerEvents.runId, run.id), eq(providerEvents.eventType, "artifact.revised")));
    const revisedArtifactIds = revisedEvents.flatMap(({ payload }) => {
      let parsed: unknown;
      try {
        parsed = payload ? JSON.parse(payload) : null;
      } catch {
        parsed = null;
      }
      const id =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).id
          : null;
      return typeof id === "string" ? [id] : [];
    });
    const artifactScope =
      revisedArtifactIds.length > 0
        ? or(eq(artifacts.runId, run.id), inArray(artifacts.id, revisedArtifactIds))
        : eq(artifacts.runId, run.id);
    const runArtifacts = await tx
      .select({
        id: artifacts.id,
        runId: artifacts.runId,
        threadId: artifacts.threadId,
        name: artifacts.name,
        contentType: artifacts.contentType,
        sizeBytes: artifacts.sizeBytes,
        sha256: artifacts.sha256,
        storageKey: artifacts.storageKey,
        workpieceRevision: artifacts.workpieceRevision,
      })
      .from(artifacts)
      .where(and(eq(artifacts.orgId, run.orgId), artifactScope))
      .orderBy(desc(artifacts.workpieceRevision), desc(artifacts.createdAt))
      .limit(SHARE_LIMIT);
    for (const artifact of runArtifacts) {
      if (artifact.sizeBytes > SHARE_MAX_BYTES) continue;
      const created = await enqueueUploadFileTx(tx, {
        idempotencyKey: slackArtifactDeliveryIdempotencyKey({
          teamId: slack.teamId,
          runId: run.id,
          artifactId: artifact.id,
          artifactRevision: artifact.workpieceRevision,
          artifactSha256: artifact.sha256,
          channel: slack.channel,
          threadTs: slack.threadTs,
        }),
        orgId: run.orgId,
        teamId: slack.teamId,
        channel: slack.channel,
        threadTs: slack.threadTs,
        filename: artifact.name,
        title: artifact.name,
        artifactId: artifact.id,
        artifactRunId: artifact.runId,
        artifactThreadId: artifact.threadId,
        deliveryRunId: run.id,
        artifactSha256: artifact.sha256,
        artifactRevision: artifact.workpieceRevision,
        artifactStorageKey: artifact.storageKey,
        artifactContentType: artifact.contentType,
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
export type FinalizeRunResult =
  | { readonly applied: false }
  | { readonly applied: true; readonly status: "completed" | "failed"; readonly summary: string };

export async function resolveDurableFinalizationOutcome(
  runId: string,
  result: FinalizeRunResult,
): Promise<{ readonly status: "completed" | "failed"; readonly summary: string } | null> {
  if (result.applied) return { status: result.status, summary: result.summary };
  const [winner] = await db
    .select({ status: runs.status, summary: runs.summary })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  if (!winner || (winner.status !== "completed" && winner.status !== "failed")) return null;
  return { status: winner.status, summary: winner.summary ?? "" };
}

export async function finalizeRun(
  runId: string,
  status: RunStatus,
  summary: string,
  durationMs: number,
): Promise<FinalizeRunResult> {
  const executionGraphMode = executionGraphRolloutMode();
  const finishedWorkMode = finishedWorkRolloutMode();
  await prepareExecutionGraphSeal(runId, executionGraphMode);
  let applied = false;
  let effectiveStatus: "completed" | "failed" = status === "completed" ? "completed" : "failed";
  let effectiveSummary = summary;
  const shadowAudit: {
    value: { decision: "blocked" | "failed"; obligationCount: number } | null;
  } = { value: null };
  let kickSlack = false;
  let settledThreadId: string | null = null;
  let settledOrgId: string | null = null;
  let settledUserId: string | null = null;
  let settledPrompt: string | null = null;
  let settledInternal = true; // stays true unless a customer run actually finalized
  await db.transaction(async (tx) => {
    if (finishedWorkMode !== "off") await lockFinishedWorkRun(runId, tx);
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
    if (!run) return; // deleted mid-flight — nothing to finalize
    settledThreadId = run.threadId;
    settledOrgId = run.orgId;
    settledUserId = run.userId;
    settledPrompt = run.prompt;
    settledInternal = isInternalRunOrigin(run.origin) || run.engine === "mock";

    // Finished-work enforcement is additive and trusted-boundary-only: Phase A
    // creates no obligations, so legacy runs evaluate `not_required`. Requested
    // failures always remain failures. Only an explicit durable obligation can
    // turn a requested completion into an effective failure.
    if (status === "completed" && finishedWorkMode !== "off" && run.orgId) {
      const finishedWorkDecision = evaluateFinishedWork(
        await listFinishedWorkForRun(run.orgId, runId, tx),
      );
      if (
        finishedWorkMode === "shadow" &&
        (finishedWorkDecision.status === "blocked" || finishedWorkDecision.status === "failed")
      ) {
        shadowAudit.value = {
          decision: finishedWorkDecision.status,
          obligationCount: finishedWorkDecision.obligations.length,
        };
      }
      if (
        (finishedWorkDecision.status === "blocked" || finishedWorkDecision.status === "failed") &&
        finishedWorkEnforcementEnabled(run.engine, run.id)
      ) {
        effectiveStatus = "failed";
        effectiveSummary = finishedWorkFailureSummary(finishedWorkDecision);
      }
    }

    // FIRST finalizer wins (completeRun guards on a non-terminal status). A
    // concurrent second finalizer - zombie-cancel racing the reconcile loop -
    // updates zero rows; skip EVERY side-effect so it can never flip the status
    // or double-enqueue a capture for an already-settled run.
    const finalized = await completeRun(runId, effectiveStatus, effectiveSummary, durationMs, tx);
    if (!finalized) {
      settledThreadId = null;
      settledOrgId = null;
      settledUserId = null;
      settledPrompt = null;
      settledInternal = true;
      return;
    }
    applied = true;
    await releaseLeaseForRun(runId, tx);
    if (executionGraphMode !== "off" && run.orgId) {
      if (effectiveStatus !== "completed" && effectiveStatus !== "failed") {
        throw new Error("execution_graph_seal_requires_terminal_run");
      }
      await sealExecutionGraphAfterFinalizeTx({
        orgId: run.orgId,
        runId,
        status: effectiveStatus,
        mode: executionGraphMode,
      }, tx);
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
    if (effectiveStatus === "completed" && !isInternalRunOrigin(run.origin)) {
      const plan = resolveScopedMemory(run);
      if (plan?.writePool && assessCaptureSalience({ prompt: run.prompt, summary: effectiveSummary }).salient) {
        // Verified outcome (item 5): capture the structured facts alongside the
        // prose — artifacts published, tool counts, status/duration/engine/model,
        // and the user-correction signal — all readable in THIS transaction.
        const evidence = await collectRunEvidence(run, effectiveStatus, durationMs, tx);
        await enqueueCapture(
          runId,
          plan.writePool.identity,
          { prompt: run.prompt, summary: effectiveSummary, evidence },
          plan.scope,
          tx,
        );
      }
    }

    // Slack reply — durable for a Slack-originated run (resolved from the run's
    // thread, so replies + boot-reconciled runs both find it). Non-Slack runs
    // resolve null and enqueue nothing.
    kickSlack = (await enqueueSlackTerminalDeliveryForRunTx(tx, run, effectiveStatus, effectiveSummary)) || kickSlack;

    // Automation delivery (delivery.slack) — a run fired by an automation whose
    // delivery config targets Slack posts its terminal outcome to that channel,
    // enqueued in THIS transaction (idempotent per run) so it survives a crash
    // exactly like the thread reply. Both terminal statuses deliver; the
    // allowlist is re-checked at delivery-enqueue time.
    const automation = await findScheduleForRun(runId, tx);
    if (automation) {
      const target = await resolveSlackAutomationTargetForOrg(
        automation.delivery,
        automation.orgId,
        tx,
      );
      if (target) {
        const created = await enqueuePostMessageTx(tx, {
          idempotencyKey: `automation-delivery:${runId}`,
          orgId: automation.orgId,
          teamId: target.teamId,
          channel: target.channel,
          text: composeAutomationDeliveryText(automation.name, effectiveStatus, effectiveSummary),
        });
        kickSlack = kickSlack || created;
      }
    }

    // Canonical lane: enqueue canonicalization durably IN this
    // transaction, so the intent to translate commits ATOMICALLY with the terminal run
    // - a crash never leaves a settled run with no canonical history. A background
    // outbox worker translates with a source-watermark stability check + retry, and
    // marks `complete` only when the whole source was translated. Native and ACP
    // engines project events/steps into the same canonical rows.
    if (terminalCanonicalizationEligible(run.engine)) {
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
    if (effectiveStatus === "completed" && run.orgId && !isInternalRunOrigin(run.origin)) {
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

  if (!applied) return { applied: false };

  if (shadowAudit.value) {
    console.info("[finished-work] shadow completion mismatch", {
      runId,
      decision: shadowAudit.value.decision,
      obligationCount: shadowAudit.value.obligationCount,
    });
  }

  // Kick the relay AFTER commit (the row isn't visible to it until then). No-op
  // when Slack isn't configured (the relay isn't running).
  if (kickSlack) kickSlackOutbox();

  // Post-commit thread signal: the run reached a terminal state, so wake any
  // connected thread stream to re-project it (final status + summary). The
  // per-run `end` bus already settles the run's transient text on the stream;
  // this carries the durable summary the `done` frame does not. Skipped when the
  // run was deleted mid-flight (settledThreadId stays null).
  if (settledThreadId && settledOrgId && !settledInternal) {
    publishRunLifecycleChange({
      orgId: settledOrgId,
      threadId: settledThreadId,
      runId,
      kind: "settled",
    });
  }

  // Follow-up suggestions (post-commit, fire-and-forget): a completed customer
  // run gets 2-3 suggested next questions appended as a native-lane frame the
  // thread stream then delivers. Strictly AFTER settle so the model call can
  // never delay the answer; internal (parity/e2e) and mock runs never generate.
  if (
    effectiveStatus === "completed" &&
    settledThreadId &&
    settledOrgId &&
    settledPrompt !== null &&
    !settledInternal
  ) {
    void recordRunFollowups(
      {
        id: runId,
        threadId: settledThreadId,
        orgId: settledOrgId,
        userId: settledUserId,
        prompt: settledPrompt,
      },
      effectiveSummary,
    );
  }
  return { applied: true, status: effectiveStatus, summary: effectiveSummary };
}
