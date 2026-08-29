/**
 * Live progress feedback for a Slack-originated run. Progress is throttled and
 * routed through the durable Slack outbox as native stream chunks - task cards
 * pairing start/complete per tool step, one plan_update per plan/todos step,
 * and exact-offset narration markdown - with the Block Kit card update carried
 * as fallback in the same outbox row. DM threads additionally get the free-text
 * working shimmer (assistant thread status), cleared when the run settles.
 *
 * This watcher is best-effort: it can miss live progress if the process dies.
 * Terminal delivery is stronger and happens in finalizeRun via durable
 * stop_stream plus plain-message fallback, so a boot-reconciled run still replies.
 */
import { getRun } from "../runs/repo";
import type { RunStatus } from "../db/schema";
import { bus, channel as runChannel, type BusEvent } from "../worker";
import { turnStream } from "../runs/turn-stream";
import { env } from "../env";
import { buildRunCard, deriveTitle, sessionUrl, type RunCardInput } from "./card";
import { parseRepoRef } from "../github/repo-ref";
import { enqueueAppendStream, enqueueSessionStatus, enqueueThreadStatus } from "./outbox";
import {
  createNarrationBuffer,
  directMessageChannel,
  markdownChunksFor,
  planUpdateFromStep,
  statusTextForStep,
  stepProgressChunks,
  type SlackStreamChunk,
} from "./streaming";

/** Min gap between progress updates so a chatty run doesn't spam Slack. */
const STATUS_THROTTLE_MS = 2_000;
/** Narration flush cadence - coalesces deltas into bounded appends. */
const NARRATION_FLUSH_MS = 2_500;

/** A monotonic min-gap throttle: `allow(now)` returns true at most once per
 *  `minGapMs`, coalescing a burst of step events into a bounded update rate. The
 *  FIRST call always passes (no prior emission to gap from). Pure + stateful
 *  factory so the gating is unit-testable without a live run. */
export function createProgressThrottle(minGapMs: number): { allow(now: number): boolean } {
  let lastAt: number | null = null;
  return {
    allow(now) {
      if (lastAt !== null && now - lastAt < minGapMs) return false;
      lastAt = now;
      return true;
    },
  };
}

export function watchSlackRun(opts: {
  runId: string;
  /** The Slack thread's ROOT run id - owns the card the updates target. Equals
   *  runId for a root run; a reply passes its thread root. */
  rootRunId: string;
  teamId: string;
  channel: string;
  threadTs: string;
}): void {
  const { runId, rootRunId, teamId, channel, threadTs } = opts;
  let settled = false;
  const throttle = createProgressThrottle(STATUS_THROTTLE_MS);
  const dm = directMessageChannel(channel);
  let lastStep: { id: string; label: string } | null = null;

  /** The card chrome (title/model/repos/url) resolved once and reused for every
   *  fallback card this watcher enqueues. */
  let cardBase: Promise<Omit<RunCardInput, "phase" | "workingStep"> | null> | null = null;
  const loadCardBase = (): Promise<Omit<RunCardInput, "phase" | "workingStep"> | null> => {
    cardBase ??= getRun(rootRunId).then((run) =>
      run
        ? {
            title: deriveTitle(run.prompt),
            model: run.model,
            repoSpecs: run.repos.map(parseRepoRef),
            webUrl: sessionUrl(env.FRONTEND_ORIGIN, run.threadId),
          }
        : null,
    );
    return cardBase;
  };

  const enqueueChunks = (input: {
    idempotencyKey: string;
    chunks: readonly SlackStreamChunk[];
    workingStep?: string;
    narrationOffset?: number;
  }): void => {
    void (async () => {
      const base = await loadCardBase();
      if (!base) return;
      const card = buildRunCard({ ...base, phase: "running", workingStep: input.workingStep });
      await enqueueAppendStream({
        idempotencyKey: input.idempotencyKey,
        teamId,
        channel,
        threadTs,
        runId,
        chunks: input.chunks,
        narrationOffset: input.narrationOffset,
        fallbackBlocks: card.blocks,
        fallbackText: card.text,
      });
    })().catch(() => {});
  };

  // ── narration: buffered deltas flushed as exact-offset markdown appends ──
  const narration = createNarrationBuffer();
  let narrationSeq = 0;
  const flushNarration = (): void => {
    const segment = narration.take();
    if (!segment) return;
    narrationSeq += 1;
    enqueueChunks({
      idempotencyKey: `slack-stream:text:${teamId}:${runId}:${narrationSeq}`,
      chunks: markdownChunksFor(segment.text),
      narrationOffset: segment.offset,
    });
  };
  const unsubscribe = turnStream.subscribe(runId, (delta, kind) => {
    if (kind !== undefined) return; // reasoning stays out of the message body
    narration.push(delta);
  });
  const narrationTimer = setInterval(flushNarration, NARRATION_FLUSH_MS);
  narrationTimer.unref?.();

  const finish = (): void => {
    if (settled) return;
    settled = true;
    bus.off(runChannel(runId), onEvent);
    unsubscribe();
    clearInterval(narrationTimer);
    void enqueueSessionStatus({
      idempotencyKey: `slack-status:end:${teamId}:${runId}`,
      teamId,
      channel,
      threadTs,
      status: "active",
    }).catch(() => {});
    if (dm) {
      void enqueueThreadStatus({
        idempotencyKey: `slack-thread-status:end:${teamId}:${runId}`,
        teamId,
        channel,
        threadTs,
        status: "",
      }).catch(() => {});
    }
  };

  const onEvent = (ev: BusEvent): void => {
    if (ev.type === "end") {
      finish();
      return;
    }
    if (ev.type !== "step" || settled || ev.step.kind === "done") return;

    // A plan/todos step surfaces as ONE plan_update chunk, throttle-exempt
    // (plans change rarely and the chunk is idempotent per step).
    const plan = planUpdateFromStep({ label: ev.step.label, chip: ev.step.chip, codeJson: ev.step.code_json });
    if (plan) {
      enqueueChunks({
        idempotencyKey: `slack-stream:plan:${teamId}:${runId}:${ev.step.id}`,
        chunks: [plan],
        workingStep: ev.step.label,
      });
      return;
    }

    // Live tool progress, throttled + coalesced: the previous task completes,
    // the new one starts. An enrichment of the SAME step never self-completes.
    if (!throttle.allow(Date.now())) return;
    const progress = stepProgressChunks(lastStep, { id: ev.step.id, label: ev.step.label });
    lastStep = progress.next;
    enqueueChunks({
      idempotencyKey: `slack-stream:step:${teamId}:${runId}:${ev.step.id}`,
      chunks: progress.chunks,
      workingStep: ev.step.label,
    });
    if (dm) {
      void enqueueThreadStatus({
        idempotencyKey: `slack-thread-status:step:${teamId}:${runId}:${ev.step.id}`,
        teamId,
        channel,
        threadTs,
        status: statusTextForStep(ev.step.label),
      }).catch(() => {});
    }
  };

  bus.on(runChannel(runId), onEvent);

  // Race guard: the run may already be terminal before we subscribed.
  void getRun(runId).then((r) => {
    if (r && isTerminal(r.status)) finish();
  });
}

const isTerminal = (s: RunStatus): boolean => s === "completed" || s === "failed";
