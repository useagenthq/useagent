import { describe, expect, test } from "bun:test";
import { eq, like, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { artifacts, providerEvents, slackOutbox, slackThreads } from "../src/db/schema";
import { acceptRunCommand } from "../src/commands";
import { finalizeRun } from "../src/runs/finalize";
import { recoverStaleRuns, type ReconcileProbe } from "../src/runs/recovery";
import { recordProviderEvent } from "../src/runs/provider-events";
import {
  createSlackRunResponse,
  findSlackThreadByRoot,
  linkSlackThread,
} from "../src/slack/repo";
import {
  getSlackOutbox,
  slackArtifactDeliveryIdempotencyKey,
} from "../src/slack/outbox";
import { createRun, setRunEngineSession, setRunSandbox, setRunStatus } from "../src/runs/repo";
import "./helpers"; // side-effect: imports src/index → migrate + seed

// Regression for GAP 3: a restart could lose the final Slack reply. The reply used
// to be enqueued by an in-process watcher — it died with the process (a boot-
// reconciled Slack run never replied) and fired AFTER completeRun (a crash in that
// gap lost it). It now enqueues transactionally at finalization (runs/finalize.ts),
// keyed `slack-reply:<runId>`, so it's durable BEFORE any watcher/relay runs.
//
// The row is now a `stop_stream` (the settled native Slack stream, with Block Kit
// blocks allowed at stop), carrying the SAME plain-text answer in
// `fallbackChunks` so the answer lands even when no stream/card ts exists.
//
// These tests read the slack_outbox ROW directly (no relay/mock), i.e. they prove
// the durable INTENT is committed with the run — the delivery mechanism is already
// covered by slack-outbox.test.ts + slack.test.ts.

const ORG = "org-skynet-dev";
const TEAM = "T-SKYNET-DEV";

/** Root a Slack thread on a fresh run (channel/threadTs are the thread identity). */
async function slackRootRun(prompt: string): Promise<{ runId: string; channel: string; ts: string }> {
  const runId = crypto.randomUUID();
  const channel = `C${runId.slice(0, 6)}`;
  const ts = `${runId.slice(0, 6)}.1`;
  await createRun({ id: runId, prompt, model: "claude-opus-5", engine: "mock", orgId: ORG, userId: null, parentRunId: null, threadId: runId });
  await linkSlackThread({ teamId: TEAM, channel, threadTs: ts, rootRunId: runId, orgId: ORG });
  await createSlackRunResponse({ runId, teamId: TEAM, channel, threadTs: ts });
  return { runId, channel, ts };
}

describe("slack reply durability at finalization (GAP 3)", () => {
  test("a completed Slack run commits its reply row transactionally (no watcher/relay)", async () => {
    const { runId, channel, ts } = await slackRootRun("do the thing");
    await finalizeRun(runId, "completed", "here is the result", 100);

    const row = await getSlackOutbox(`slack-reply:${TEAM}:${runId}`);
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("stop_stream");
    const payload = JSON.parse(row!.payload) as {
      channel: string;
      fallbackChunks: string[];
      threadTs?: string;
      runId: string;
      teamId: string;
    };
    expect(payload.channel).toBe(channel);
    expect(payload.teamId).toBe(TEAM);
    expect(payload.threadTs).toBe(ts);
    expect(payload.runId).toBe(runId);
    expect(payload.fallbackChunks).toEqual(["here is the result"]); // completed → the summary
    const status = await getSlackOutbox(`slack-status:final:${TEAM}:${runId}`);
    expect(status).not.toBeNull();
    expect(status!.kind).toBe("set_session_status");
    expect((JSON.parse(status!.payload) as { status: string }).status).toBe("active");
  });

  test("a FAILED Slack run replies with a warning notice", async () => {
    const { runId } = await slackRootRun("this will fail");
    await finalizeRun(runId, "failed", "boom", 0);
    const row = await getSlackOutbox(`slack-reply:${TEAM}:${runId}`);
    expect(row).not.toBeNull();
    expect((JSON.parse(row!.payload) as { fallbackChunks: string[] }).fallbackChunks).toEqual([":warning: Run failed: boom"]);
  });

  test("a non-Slack run enqueues NO reply", async () => {
    const id = crypto.randomUUID();
    await createRun({ id, prompt: "api run", model: "claude-opus-5", engine: "mock", orgId: ORG, userId: null, parentRunId: null, threadId: id });
    await finalizeRun(id, "completed", "done", 10);
    const replies = await db
      .select({ id: slackOutbox.id })
      .from(slackOutbox)
      .where(like(slackOutbox.idempotencyKey, `slack-reply:%:${id}`));
    expect(replies).toHaveLength(0);
  });

  test("a Slack root cannot be rebound through a different organization", async () => {
    const root = await slackRootRun("tenant-bound Slack thread");
    await expect(db.insert(slackThreads).values({
      teamId: `${TEAM}-OTHER`,
      channel: `${root.channel}-OTHER`,
      threadTs: `${root.ts}2`,
      rootRunId: root.runId,
      orgId: "org-other",
    }).execute()).rejects.toThrow();
    expect(await findSlackThreadByRoot(root.runId, db, "org-other")).toBeNull();
    expect(await findSlackThreadByRoot(root.runId, db, ORG)).toMatchObject({
      teamId: TEAM,
      channel: root.channel,
      threadTs: root.ts,
    });
  });

  test("a mismatched per-run Slack response fails closed instead of crossing targets", async () => {
    const root = await slackRootRun("valid root binding");
    const runId = crypto.randomUUID();
    await createRun({
      id: runId,
      prompt: "web follow-up with corrupt response",
      model: "claude-opus-5",
      engine: "mock",
      orgId: ORG,
      userId: null,
      parentRunId: root.runId,
      threadId: root.runId,
    });
    await createSlackRunResponse({
      runId,
      teamId: "T-WRONG",
      channel: "C-WRONG",
      threadTs: "9.9",
    });
    await finalizeRun(runId, "completed", "must not cross Slack targets", 10);
    const replies = await db
      .select({ id: slackOutbox.id })
      .from(slackOutbox)
      .where(like(slackOutbox.idempotencyKey, `slack-reply:%:${runId}`));
    expect(replies).toHaveLength(0);
  });

  test("a web follow-up in a Slack-linked thread adopts delivery and uploads its artifact", async () => {
    const root = await slackRootRun("start in Slack");
    const runId = crypto.randomUUID();
    await createRun({
      id: runId,
      prompt: "finish in the web app",
      model: "claude-opus-5",
      engine: "mock",
      orgId: ORG,
      userId: null,
      parentRunId: root.runId,
      threadId: root.runId,
    });
    const [artifact] = await db.insert(artifacts).values({
      orgId: ORG,
      runId,
      threadId: root.runId,
      sourcePath: "/sandbox/report.pdf",
      name: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 64,
      sha256: "b".repeat(64),
      storageKey: `test/${runId}/report.pdf`,
    }).returning({ id: artifacts.id });
    if (!artifact) throw new Error("artifact fixture failed");

    await finalizeRun(runId, "completed", "web follow-up finished", 100);

    expect(await getSlackOutbox(`slack-reply:${TEAM}:${runId}`)).not.toBeNull();
    const upload = await getSlackOutbox(slackArtifactDeliveryIdempotencyKey({
      teamId: TEAM,
      runId,
      artifactId: artifact.id,
      artifactRevision: 0,
      artifactSha256: "b".repeat(64),
      channel: root.channel,
      threadTs: root.ts,
    }));
    expect(upload).not.toBeNull();
    expect(upload?.kind).toBe("upload_file");
    expect(JSON.parse(upload?.payload ?? "{}")).toMatchObject({
      teamId: TEAM,
      orgId: ORG,
      channel: root.channel,
      threadTs: root.ts,
      artifactId: artifact.id,
      artifactRevision: 0,
      artifactSha256: "b".repeat(64),
    });

    const revisionRunId = crypto.randomUUID();
    await createRun({
      id: revisionRunId, prompt: "revise in the web app", model: "claude-opus-5", engine: "mock",
      orgId: ORG, userId: null, parentRunId: runId, threadId: root.runId,
    });
    await db.update(artifacts).set({
      sha256: "c".repeat(64), storageKey: `test/${revisionRunId}/report-v2.pdf`, workpieceRevision: 1,
    }).where(eq(artifacts.id, artifact.id));
    await db.insert(providerEvents).values({
      id: `artifact.revised:${artifact.id}:1`, runId: revisionRunId, threadId: root.runId,
      seq: 1, provider: "skynet", eventType: "artifact.revised", payload: JSON.stringify({ id: artifact.id }),
    });
    await finalizeRun(revisionRunId, "completed", "revised web follow-up finished", 100);
    expect(await getSlackOutbox(slackArtifactDeliveryIdempotencyKey({
      teamId: TEAM,
      runId: revisionRunId,
      artifactId: artifact.id,
      artifactRevision: 1,
      artifactSha256: "c".repeat(64),
      channel: root.channel,
      threadTs: root.ts,
    }))).not.toBeNull();
  });

  test("reply enqueue is idempotent across re-finalization (crash-retry safe)", async () => {
    const { runId } = await slackRootRun("idempotent");
    await finalizeRun(runId, "completed", "sum", 1);
    await finalizeRun(runId, "completed", "sum", 1);
    const row = await getSlackOutbox(`slack-reply:${TEAM}:${runId}`);
    expect(row).not.toBeNull();
    const rows = await db
      .select({ id: slackOutbox.id })
      .from(slackOutbox)
      .where(eq(slackOutbox.idempotencyKey, `slack-reply:${TEAM}:${runId}`));
    expect(rows).toHaveLength(1);
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
    await linkSlackThread({ teamId: TEAM, channel, threadTs: ts, rootRunId: runId, orgId: ORG });
    await createSlackRunResponse({ runId, teamId: TEAM, channel, threadTs: ts });
    await setRunStatus(runId, "running");
    await setRunEngineSession(runId, "ses_done");
    await setRunSandbox(runId, "sb");
    await recordProviderEvent({
      id: `legacy-opencode-session:${runId}`,
      runId,
      threadId: runId,
      provider: "opencode",
      eventType: "session.started",
      nativeSessionId: "ses_done",
      payload: { source: "opencode" },
    }, { critical: true });
    await db.execute(sql`update commands set state='dispatched' where run_id=${runId} and kind='run.create'`);

    const reconcile: ReconcileProbe = async (h) =>
      h.sessionId === "ses_done" ? { status: "completed", summary: "reconciled reply" } : { status: "unreachable" };
    const res = await recoverStaleRuns(reconcile);
    expect(res.reconciled).toBeGreaterThanOrEqual(1);

    const row = await getSlackOutbox(`slack-reply:${TEAM}:${runId}`);
    expect(row).not.toBeNull();
    expect((JSON.parse(row!.payload) as { fallbackChunks: string[] }).fallbackChunks).toEqual(["reconciled reply"]);
  });
});
