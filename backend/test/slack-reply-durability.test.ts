import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { acceptRunCommand } from "../src/commands";
import { finalizeRun } from "../src/runs/finalize";
import { recoverStaleRuns, type ReconcileProbe } from "../src/runs/recovery";
import { linkSlackThread } from "../src/slack/repo";
import { getSlackOutbox } from "../src/slack/outbox";
import { createRun, setRunEngineSession, setRunSandbox, setRunStatus } from "../src/runs/repo";
import "./helpers"; // side-effect: imports src/index → migrate + seed

// Regression for GAP 3: a restart could lose the final Slack reply. The reply used
// to be enqueued by an in-process watcher — it died with the process (a boot-
// reconciled Slack run never replied) and fired AFTER completeRun (a crash in that
// gap lost it). It now enqueues transactionally at finalization (runs/finalize.ts),
// keyed `slack-reply:<runId>`, so it's durable BEFORE any watcher/relay runs.
//
// The row is now an `update_card` (the settled Block Kit run card, advanced in
// place at delivery), carrying the SAME plain-text answer in `fallbackChunks` -
// what `chunks` used to hold - so the answer lands even when no card ts exists.
//
// These tests read the slack_outbox ROW directly (no relay/mock), i.e. they prove
// the durable INTENT is committed with the run — the delivery mechanism is already
// covered by slack-outbox.test.ts + slack.test.ts.

const ORG = "org-skynet-dev";

/** Root a Slack thread on a fresh run (channel/threadTs are the thread identity). */
async function slackRootRun(prompt: string): Promise<{ runId: string; channel: string; ts: string }> {
  const runId = crypto.randomUUID();
  const channel = `C${runId.slice(0, 6)}`;
  const ts = `${runId.slice(0, 6)}.1`;
  await createRun({ id: runId, prompt, model: "claude-opus-5", engine: "mock", orgId: ORG, userId: null, parentRunId: null, threadId: runId });
  await linkSlackThread({ channel, threadTs: ts, rootRunId: runId, orgId: ORG });
  return { runId, channel, ts };
}

describe("slack reply durability at finalization (GAP 3)", () => {
  test("a completed Slack run commits its reply row transactionally (no watcher/relay)", async () => {
    const { runId, channel, ts } = await slackRootRun("do the thing");
    await finalizeRun(runId, "completed", "here is the result", 100);

    const row = await getSlackOutbox(`slack-reply:${runId}`);
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("update_card");
    const payload = JSON.parse(row!.payload) as {
      channel: string;
      fallbackChunks: string[];
      threadTs?: string;
      rootRunId: string;
    };
    expect(payload.channel).toBe(channel);
    expect(payload.threadTs).toBe(ts);
    expect(payload.rootRunId).toBe(runId);
    expect(payload.fallbackChunks).toEqual(["here is the result"]); // completed → the summary
  });

  test("a FAILED Slack run replies with a warning notice", async () => {
    const { runId } = await slackRootRun("this will fail");
    await finalizeRun(runId, "failed", "boom", 0);
    const row = await getSlackOutbox(`slack-reply:${runId}`);
    expect(row).not.toBeNull();
    expect((JSON.parse(row!.payload) as { fallbackChunks: string[] }).fallbackChunks).toEqual([":warning: Run failed: boom"]);
  });

  test("a non-Slack run enqueues NO reply", async () => {
    const id = crypto.randomUUID();
    await createRun({ id, prompt: "api run", model: "claude-opus-5", engine: "mock", orgId: ORG, userId: null, parentRunId: null, threadId: id });
    await finalizeRun(id, "completed", "done", 10);
    expect(await getSlackOutbox(`slack-reply:${id}`)).toBeNull();
  });

  test("reply enqueue is idempotent across re-finalization (crash-retry safe)", async () => {
    const { runId } = await slackRootRun("idempotent");
    await finalizeRun(runId, "completed", "sum", 1);
    await finalizeRun(runId, "completed", "sum", 1);
    const row = await getSlackOutbox(`slack-reply:${runId}`);
    expect(row).not.toBeNull();
    expect(row!.attemptCount).toBe(0); // one original pending row, never duplicated
  });

  test("a BOOT-RECONCILED Slack run still replies (the watcher-death case)", async () => {
    // A Slack-originated opencode run, running + command dispatched, whose native
    // session finished server-side. The in-process watcher is GONE after a
    // restart; boot recovery reconciles via finalizeRun, which enqueues the reply.
    const runId = crypto.randomUUID();
    const channel = `C${runId.slice(0, 6)}`;
    const ts = `${runId.slice(0, 6)}.1`;
    await acceptRunCommand({
      idempotencyKey: null, orgId: ORG, actorId: null,
      run: { id: runId, prompt: "slack reconcile", model: "claude-opus-5", engine: "opencode", parentRunId: null, threadId: runId },
    });
    await linkSlackThread({ channel, threadTs: ts, rootRunId: runId, orgId: ORG });
    await setRunStatus(runId, "running");
    await setRunEngineSession(runId, "ses_done");
    await setRunSandbox(runId, "sb");
    await db.execute(sql`update commands set state='dispatched' where run_id=${runId} and kind='run.create'`);

    const reconcile: ReconcileProbe = async (h) =>
      h.sessionId === "ses_done" ? { status: "completed", summary: "reconciled reply" } : { status: "unreachable" };
    const res = await recoverStaleRuns(reconcile);
    expect(res.reconciled).toBeGreaterThanOrEqual(1);

    const row = await getSlackOutbox(`slack-reply:${runId}`);
    expect(row).not.toBeNull();
    expect((JSON.parse(row!.payload) as { fallbackChunks: string[] }).fallbackChunks).toEqual(["reconciled reply"]);
  });
});
