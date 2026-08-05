/**
 * Live assistant-status shimmer for a Slack-originated run. QM streamed live turn
 * progress back to Slack; v1 keeps it to the AI-Apps status line ("Starting up…",
 * "Running: <step>", cleared on completion).
 *
 * This is BEST-EFFORT and EPHEMERAL by construction — it does NOT survive a
 * backend restart and the client swallows Slack errors. The DURABLE final reply is
 * NO LONGER posted here: it is enqueued transactionally at run finalization
 * (runs/finalize.ts → slack_outbox, keyed `slack-reply:<runId>`), so it survives a
 * crash/restart and lands even for a boot-reconciled run — the class of loss this
 * in-process watcher could never cover.
 */
import { getRun } from "../runs/repo";
import type { RunStatus } from "../db/schema";
import { bus, channel as runChannel, type BusEvent } from "../worker";
import type { SlackClient } from "./client";

/** Min gap between assistant-status updates so a chatty run doesn't spam Slack. */
const STATUS_THROTTLE_MS = 2_000;

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
  // durable ack-emoji + completion reply remain the visible behavior.
  const setStatus = (status: string): void => {
    void Promise.resolve(client.setAssistantStatus({ channel, threadTs, status })).catch(() => {});
  };
  setStatus("Starting up…");

  const finish = (): void => {
    if (settled) return;
    settled = true;
    bus.off(runChannel(runId), onEvent);
    setStatus(""); // clear the shimmer; the durable reply is enqueued at finalization
  };

  const onEvent = (ev: BusEvent): void => {
    if (ev.type === "end") {
      finish();
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
    if (r && isTerminal(r.status)) finish();
  });
}

const isTerminal = (s: RunStatus): boolean => s === "completed" || s === "failed";
