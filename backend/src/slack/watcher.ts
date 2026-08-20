/**
 * Live progress feedback for a Slack-originated run. Progress is throttled and
 * routed through the durable Slack outbox as native stream task_update chunks,
 * with the Block Kit card update carried as fallback in the same outbox row.
 *
 * This watcher is best-effort: it can miss live progress if the process dies.
 * Terminal delivery is stronger and happens in finalizeRun via durable
 * stop_stream plus plain-message fallback, so a boot-reconciled run still replies.
 */
import { getRun } from "../runs/repo";
import type { RunStatus } from "../db/schema";
import { bus, channel as runChannel, type BusEvent } from "../worker";
import { env } from "../env";
import { buildRunCard, deriveTitle, sessionUrl } from "./card";
import { parseRepoRef } from "../github/repo-ref";
import { enqueueAppendStream, enqueueSessionStatus } from "./outbox";
import { runningTaskChunk } from "./streaming";

/** Min gap between progress updates so a chatty run doesn't spam Slack. */
const STATUS_THROTTLE_MS = 2_000;

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

  const enqueueProgress = (stepId: string, stepLabel: string): void => {
    void (async () => {
      const run = await getRun(rootRunId);
      if (!run) return;
      const card = buildRunCard({
        title: deriveTitle(run.prompt),
        phase: "running",
        model: run.model,
        repoSpecs: run.repos.map(parseRepoRef),
        webUrl: sessionUrl(env.FRONTEND_ORIGIN, run.threadId),
        workingStep: stepLabel,
      });
      await enqueueAppendStream({
        idempotencyKey: `slack-stream:step:${teamId}:${runId}:${stepId}`,
        teamId,
        channel,
        threadTs,
        runId,
        chunks: [runningTaskChunk({ id: stepId, label: stepLabel })],
        fallbackBlocks: card.blocks,
        fallbackText: card.text,
      });
    })().catch(() => {});
  };

  const finish = (): void => {
    if (settled) return;
    settled = true;
    bus.off(runChannel(runId), onEvent);
    void enqueueSessionStatus({
      idempotencyKey: `slack-status:end:${teamId}:${runId}`,
      teamId,
      channel,
      threadTs,
      status: "active",
    }).catch(() => {});
  };

  const onEvent = (ev: BusEvent): void => {
    if (ev.type === "end") {
      finish();
      return;
    }
    if (ev.type === "step" && !settled) {
      // Live progress, throttled + coalesced; skip the terminal "done" step.
      if (ev.step.kind !== "done" && throttle.allow(Date.now())) {
        enqueueProgress(ev.step.id, ev.step.label);
      }
    }
  };

  bus.on(runChannel(runId), onEvent);

  // Race guard: the run may already be terminal before we subscribed.
  void getRun(runId).then((r) => {
    if (r && isTerminal(r.status)) finish();
  });
}

const isTerminal = (s: RunStatus): boolean => s === "completed" || s === "failed";
