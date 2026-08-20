/**
 * Live progress feedback for a Slack-originated run. Two best-effort, EPHEMERAL
 * surfaces, both throttled so a chatty run never spams Slack:
 *   1. the AI-Apps assistant shimmer ("Starting up…", "Running: <step>", cleared
 *      on completion) - the status line above the composer; and
 *   2. the Block Kit RUN CARD, advanced in place (queued -> running + a short
 *      "working: <step>" line) via chat.update on the stored card ts.
 *
 * Both are BEST-EFFORT by construction - they do NOT survive a backend restart and
 * every Slack error is swallowed, so a feedback failure never fails the run. The
 * DURABLE surfaces are elsewhere: the card POST (slack_outbox post_card, at run
 * acceptance) and the SETTLED card update + plain-text fallback (slack_outbox
 * update_card, in the finalization transaction, keyed `slack-reply:<runId>`), so
 * the final answer lands even for a boot-reconciled run.
 */
import { getRun } from "../runs/repo";
import type { RunStatus } from "../db/schema";
import { bus, channel as runChannel, type BusEvent } from "../worker";
import { env } from "../env";
import type { SlackClient } from "./client";
import { getSlackCardTsByRoot } from "./repo";
import { buildRunCard, deriveTitle, sessionUrl } from "./card";
import { parseRepoRef } from "../github/repo-ref";

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
  client: SlackClient;
  channel: string;
  threadTs: string;
}): void {
  const { runId, rootRunId, client, channel, threadTs } = opts;
  let settled = false;
  const throttle = createProgressThrottle(STATUS_THROTTLE_MS);

  // AI-Apps assistant shimmer ("Starting up…"). Best-effort by construction:
  // the client swallows Slack errors, so in non-assistant contexts (channel
  // mentions, apps without the feature) these are silent no-ops and the
  // durable ack-emoji + completion card remain the visible behavior.
  const setStatus = (status: string): void => {
    void Promise.resolve(client.setAssistantStatus({ channel, threadTs, status })).catch(() => {});
  };
  setStatus("Starting up…");

  // Advance the run card to "running" with the current step, best-effort. The
  // card chrome (title/model/repos) is read once from the root run and reused, so
  // a per-step update is a single chat.update. Any failure (no card ts yet, Slack
  // error) is swallowed - the durable settled update at finalization is the source
  // of truth for the card's final state.
  const updateCardRunning = (stepLabel: string): void => {
    void (async () => {
      const [link, run] = await Promise.all([getSlackCardTsByRoot(rootRunId), getRun(rootRunId)]);
      if (!link?.cardTs || !run) return;
      const card = buildRunCard({
        title: deriveTitle(run.prompt),
        phase: "running",
        model: run.model,
        repoSpecs: run.repos.map(parseRepoRef),
        webUrl: sessionUrl(env.FRONTEND_ORIGIN, run.threadId),
        workingStep: stepLabel,
      });
      await client.updateMessage({ channel, ts: link.cardTs, text: card.text, blocks: card.blocks });
    })().catch(() => {});
  };

  const finish = (): void => {
    if (settled) return;
    settled = true;
    bus.off(runChannel(runId), onEvent);
    setStatus(""); // clear the shimmer; the durable settled card is enqueued at finalization
  };

  const onEvent = (ev: BusEvent): void => {
    if (ev.type === "end") {
      finish();
      return;
    }
    if (ev.type === "step" && !settled) {
      // Live progress, throttled + coalesced; skip the terminal "done" step.
      if (ev.step.kind !== "done" && throttle.allow(Date.now())) {
        setStatus(`Running: ${ev.step.label}`);
        updateCardRunning(ev.step.label);
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
