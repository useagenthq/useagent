/**
 * Run-completion watcher for Slack-originated runs. QM streamed live turn
 * progress back to Slack; v1 keeps it simple — subscribe in-process to the run
 * bus and, on the terminal `end` event, post the run summary (or a failure
 * notice) into the originating Slack thread.
 *
 * In-process only: a watcher does NOT survive a backend restart (acceptable for
 * v1 — the inbound thread→run mapping IS durable, in `slack_threads`). The
 * subscribe-then-recheck pattern mirrors the SSE route, closing the race where
 * a fast run finishes before we attach.
 */
import { getRun } from "../runs/repo";
import type { RunStatus } from "../db/schema";
import { bus, channel as runChannel, type BusEvent } from "../worker";
import type { SlackClient } from "./client";
import { enqueuePostMessage } from "./outbox";

/** Min gap between assistant-status updates so a chatty run doesn't spam Slack. */
const STATUS_THROTTLE_MS = 2_000;

/**
 * Outbound delivery seam. v1 posts only the final text (`done: true`), now
 * through the DURABLE outbox keyed `slack-reply:<runId>` — a backend restart no
 * longer loses an undelivered reply, and the key bounds it to one delivery. When
 * we adopt Slack's streaming APIs, incremental (`done: false`) calls become
 * appendStream frames — the watcher already funnels all outbound text here.
 */
async function deliverRunText(
  args: { runId: string; channel: string; threadTs: string; text: string; done: boolean },
): Promise<void> {
  if (!args.done) return; // streaming not implemented yet — see seam note above
  await enqueuePostMessage({
    idempotencyKey: `slack-reply:${args.runId}`,
    channel: args.channel,
    text: args.text,
    threadTs: args.threadTs,
  });
}

export function watchSlackRun(opts: {
  runId: string;
  client: SlackClient;
  channel: string;
  threadTs: string;
}): void {
  const { runId, client, channel, threadTs } = opts;
  let settled = false;
  let lastStatusAt = 0;

  // AI-Apps assistant shimmer ("Starting up…"). Best-effort by construction:
  // the client swallows Slack errors, so in non-assistant contexts (channel
  // mentions, apps without the feature) these are silent no-ops and the
  // ack-emoji + completion-post path below remains the visible behavior.
  const setStatus = (status: string): void => {
    void Promise.resolve(client.setAssistantStatus({ channel, threadTs, status })).catch(() => {});
  };
  setStatus("Starting up…");

  const finish = async (status: RunStatus): Promise<void> => {
    if (settled) return;
    settled = true;
    bus.off(runChannel(runId), onEvent);
    setStatus(""); // clear the shimmer before the reply lands
    const run = await getRun(runId);
    const text =
      status === "completed"
        ? run?.summary?.trim() || "Done."
        : `:warning: Run failed${run?.summary ? `: ${run.summary}` : "."}`;
    await deliverRunText({ runId, channel, threadTs, text, done: true });
  };

  const onEvent = (ev: BusEvent): void => {
    if (ev.type === "end") {
      void finish(ev.status);
      return;
    }
    if (ev.type === "step" && !settled) {
      // Live progress in the shimmer, throttled; skip the terminal "done" step.
      const now = Date.now();
      if (ev.step.kind !== "done" && now - lastStatusAt >= STATUS_THROTTLE_MS) {
        lastStatusAt = now;
        setStatus(`Running: ${ev.step.label}`);
      }
    }
  };

  bus.on(runChannel(runId), onEvent);

  // Race guard: the run may already be terminal before we subscribed.
  void getRun(runId).then((r) => {
    if (r && (r.status === "completed" || r.status === "failed")) void finish(r.status);
  });
}
