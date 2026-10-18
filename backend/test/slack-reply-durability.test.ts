import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { artifacts, providerEvents, slackOutbox, slackThreads } from "../src/db/schema";
import { acceptRunCommand } from "../src/commands";
import { finalizeRun, setFamilyLivenessBarrierForTest } from "../src/runs/finalize";
import { recoverStaleRuns, type ReconcileProbe } from "../src/runs/recovery";
import { recordProviderEventIfAbsent } from "../src/runs/provider-events";
import {
  createSlackRunResponse,
  findSlackThreadByRoot,
  linkSlackThread,
} from "../src/slack/repo";
import {
  getSlackOutbox,
  slackArtifactDeliveryIdempotencyKey,
} from "../src/slack/outbox";
import { createRun, setRunProviderSession, setRunSandbox, setRunStatus } from "../src/runs/repo";
import { providerSessionBinding } from "@useagent/agent-harness/canonical";
import { providerProtocolIdentity } from "@useagent/agent-harness/control";
import { t3ProviderDrivers } from "../src/engines/t3-provider-driver";
import { insertThreadRelationship } from "../src/runs/thread-relationship-repo";
import { insertCommandWithRun } from "../src/commands/repo";
import { DEV_ORG_ID } from "../src/dev-org";
import { PLATFORM_EVENT_LANES } from "@useagent/agent-harness/canonical";
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

const ORG = DEV_ORG_ID;
const TEAM = "T-USEAGENT-DURABLE";

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

// This suite proves what finalization ENQUEUES and never drains it: the relay
// is not always running when it does, so its rows would otherwise sit pending
// and be claimed ahead of a later suite's own rows (a single delivery pass
// claims twenty). The team id is this suite's alone, so the rows keyed on it
// are too: remove them on the way out.
afterAll(async () => {
  await db.delete(slackOutbox).where(like(slackOutbox.idempotencyKey, `%:${TEAM}:%`));
});

describe("slack reply durability at finalization (GAP 3)", () => {
  test("a completed Slack run commits its reply row transactionally (no watcher/relay)", async () => {
    const { runId, channel, ts } = await slackRootRun("do the thing");
    await finalizeRun(runId, "completed", "here is the result", 100);

    const row = await getSlackOutbox(`slack-reply:${TEAM}:${runId}`);
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("stop_stream");
    const payload = JSON.parse(row!.payload) as {
      channel: string;
      closingMarkdown?: string;
      text: string;
      threadTs?: string;
      runId: string;
      teamId: string;
    };
    expect(payload.channel).toBe(channel);
    expect(payload.teamId).toBe(TEAM);
    expect(payload.threadTs).toBe(ts);
    expect(payload.runId).toBe(runId);
    // completed → the summary, stored once as markdown; its plain form is
    // derived at delivery (the notification text is its first chunk).
    expect(payload.closingMarkdown).toBe("here is the result");
    expect(payload.text).toBe("here is the result");
    // The working shimmer clears durably with the reply (the one status family a thread uses).
    const status = await getSlackOutbox(`slack-thread-status:final:${TEAM}:${runId}`);
    expect(status).not.toBeNull();
    expect(status!.kind).toBe("set_thread_status");
    expect((JSON.parse(status!.payload) as { status: string }).status).toBe("");
  });

  test("a FAILED Slack run replies with a warning notice", async () => {
    const { runId } = await slackRootRun("this will fail");
    await finalizeRun(runId, "failed", "boom", 0);
    const row = await getSlackOutbox(`slack-reply:${TEAM}:${runId}`);
    expect(row).not.toBeNull();
    const failed = JSON.parse(row!.payload) as { closingMarkdown?: string; text: string };
    expect(failed.closingMarkdown).toBe("**Run failed**: boom");
    expect(failed.text).toBe("*Run failed*: boom");
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
    const revisionEvent = {
      id: `artifact.revised:${artifact.id}:1`,
      runId: revisionRunId,
      threadId: root.runId,
      provider: PLATFORM_EVENT_LANES.platform,
      eventType: "artifact.revised",
      payload: { id: artifact.id, sha256: "c".repeat(64), workpiece: { state_revision: 1 } },
    } as const;
    expect(await recordProviderEventIfAbsent(revisionEvent)).toBe(true);
    expect(await recordProviderEventIfAbsent({
      ...revisionEvent,
      payload: { id: artifact.id, sha256: "d".repeat(64), workpiece: { state_revision: 99 } },
    })).toBe(false);
    await finalizeRun(revisionRunId, "completed", "revised web follow-up finished", 100);
    await finalizeRun(revisionRunId, "completed", "revised web follow-up finished", 100);
    const revisionUploadKey = slackArtifactDeliveryIdempotencyKey({
      teamId: TEAM,
      runId: revisionRunId,
      artifactId: artifact.id,
      artifactRevision: 1,
      artifactSha256: "c".repeat(64),
      channel: root.channel,
      threadTs: root.ts,
    });
    const revisionUpload = await getSlackOutbox(revisionUploadKey);
    expect(JSON.parse(revisionUpload?.payload ?? "{}")).toMatchObject({
      artifactId: artifact.id,
      artifactRevision: 1,
      artifactSha256: "c".repeat(64),
      artifactStorageKey: `test/${revisionRunId}/report-v2.pdf`,
      deliveryRunId: revisionRunId,
    });
    const revisionEvents = await db.select({ payload: providerEvents.payload })
      .from(providerEvents)
      .where(and(
        eq(providerEvents.runId, revisionRunId),
        eq(providerEvents.eventType, "artifact.revised"),
      ));
    expect(revisionEvents).toHaveLength(1);
    expect(JSON.parse(revisionEvents[0]?.payload ?? "{}")).toMatchObject({
      id: artifact.id,
      sha256: "c".repeat(64),
      workpiece: { state_revision: 1 },
    });
    const revisionUploads = await db.select({ id: slackOutbox.id })
      .from(slackOutbox)
      .where(eq(slackOutbox.idempotencyKey, revisionUploadKey));
    expect(revisionUploads).toHaveLength(1);
  });

  test("a product child thread delivers its result into the parent Slack thread", async () => {
    const root = await slackRootRun("coordinate children");
    await insertThreadRelationship({
      orgId: ORG,
      threadId: root.runId,
      parentThreadId: null,
      familyThreadId: root.runId,
      kind: "root",
      title: "Coordinate children",
      sourceRunId: root.runId,
    });
    const childId = crypto.randomUUID();
    await insertCommandWithRun({
      commandId: crypto.randomUUID(),
      idempotencyKey: null,
      orgId: ORG,
      actorId: null,
      payloadFingerprint: "a".repeat(64),
      payload: "{}",
      origin: null,
      priority: 0,
      run: {
        id: childId,
        prompt: "Design the calendar interactions",
        model: "claude-opus-5",
        engine: "mock",
        parentRunId: null,
        threadId: childId,
        repos: [],
        resolvedResources: [],
        attachmentIds: [],
        memoryScope: "org",
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
      threadRelationship: {
        parentThreadId: root.runId,
        familyThreadId: root.runId,
        kind: "delegated",
        title: "Calendar interaction design",
        sourceRunId: root.runId,
        sourceExecutionId: null,
      },
    });

    const started = await getSlackOutbox(`slack-child:started:${TEAM}:${childId}`);
    expect(started?.kind).toBe("post_message");
    expect(JSON.parse(started?.payload ?? "{}")).toMatchObject({
      channel: root.channel,
      threadTs: root.ts,
    });

    // The root's own turn is over; only then does the family card settle.
    await setRunStatus(root.runId, "completed");
    await finalizeRun(childId, "completed", "Interaction design finished", 100);

    const reply = await getSlackOutbox(`slack-reply:${TEAM}:${childId}`);
    expect(reply).not.toBeNull();
    const payload = JSON.parse(reply?.payload ?? "{}") as {
      channel?: string;
      threadTs?: string;
      closingMarkdown?: string;
      blocks?: unknown[];
    };
    expect(payload.channel).toBe(root.channel);
    expect(payload.threadTs).toBe(root.ts);
    expect(payload.closingMarkdown).toBe("Interaction design finished");
    // The thread card settles from the family ROOT, never from the child: the
    // parent's title, session link and identity stay on the shared card.
    const cardRow = await getSlackOutbox(`slack-card:final:${TEAM}:${childId}`);
    const card = JSON.parse(cardRow?.payload ?? "{}") as { rootRunId?: string; blocks?: any[] };
    expect(card.rootRunId).toBe(root.runId);
    expect(card.blocks?.[0]).toMatchObject({ type: "task_card", title: "Coordinate children", status: "complete" });
    expect(card.blocks?.[1]?.elements?.[0]?.url).toContain(`/session/${root.runId}`);
    expect(JSON.stringify(card.blocks)).not.toContain(childId);
    expect(JSON.stringify(card.blocks)).not.toContain("Calendar interaction design");
  });

  test("a finishing child keeps the family card spinning while a sibling is still queued", async () => {
    const root = await slackRootRun("coordinate siblings");
    await insertThreadRelationship({
      orgId: ORG,
      threadId: root.runId,
      parentThreadId: null,
      familyThreadId: root.runId,
      kind: "root",
      title: "Coordinate siblings",
      sourceRunId: root.runId,
    });
    const child = async (prompt: string, title: string) => {
      const id = crypto.randomUUID();
      await insertCommandWithRun({
        commandId: crypto.randomUUID(),
        idempotencyKey: null,
        orgId: ORG,
        actorId: null,
        payloadFingerprint: "b".repeat(64),
        payload: "{}",
        origin: null,
        priority: 0,
        run: {
          id,
          prompt,
          model: "claude-opus-5",
          engine: "mock",
          parentRunId: null,
          threadId: id,
          repos: [],
          resolvedResources: [],
          attachmentIds: [],
          memoryScope: "org",
          skillId: null,
          skillVersion: null,
          skillContentHash: null,
          commandName: null,
          commandProvider: null,
          commandSessionId: null,
          commandCatalogRevision: null,
        },
        threadRelationship: {
          parentThreadId: root.runId,
          familyThreadId: root.runId,
          kind: "delegated",
          title,
          sourceRunId: root.runId,
          sourceExecutionId: null,
        },
      });
      return id;
    };
    const first = await child("Design the calendar", "Calendar design");
    const second = await child("Design the inbox", "Inbox design");
    await setRunStatus(root.runId, "completed");
    const cardStatus = async (runId: string) => {
      const row = await getSlackOutbox(`slack-card:final:${TEAM}:${runId}`);
      return (JSON.parse(row?.payload ?? "{}") as { blocks?: Array<{ status?: string; output?: unknown }> }).blocks?.[0];
    };

    await finalizeRun(first, "completed", "Calendar done", 100);
    // The sibling is still queued: the shared card keeps spinning, its verb cleared.
    expect(await cardStatus(first)).toMatchObject({ status: "in_progress" });
    expect((await cardStatus(first))?.output).toBeUndefined();

    await finalizeRun(second, "completed", "Inbox done", 100);
    expect(await cardStatus(second)).toMatchObject({ status: "complete" });
  });

  test("two sibling children finalizing at once still settle the family card", async () => {
    const root = await slackRootRun("coordinate at once");
    await insertThreadRelationship({
      orgId: ORG,
      threadId: root.runId,
      parentThreadId: null,
      familyThreadId: root.runId,
      kind: "root",
      title: "Coordinate at once",
      sourceRunId: root.runId,
    });
    const child = async (prompt: string, title: string) => {
      const id = crypto.randomUUID();
      await insertCommandWithRun({
        commandId: crypto.randomUUID(),
        idempotencyKey: null,
        orgId: ORG,
        actorId: null,
        payloadFingerprint: "c".repeat(64),
        payload: "{}",
        origin: null,
        priority: 0,
        run: {
          id,
          prompt,
          model: "claude-opus-5",
          engine: "mock",
          parentRunId: null,
          threadId: id,
          repos: [],
          resolvedResources: [],
          attachmentIds: [],
          memoryScope: "org",
          skillId: null,
          skillVersion: null,
          skillContentHash: null,
          commandName: null,
          commandProvider: null,
          commandSessionId: null,
          commandCatalogRevision: null,
        },
        threadRelationship: {
          parentThreadId: root.runId,
          familyThreadId: root.runId,
          kind: "delegated",
          title,
          sourceRunId: root.runId,
          sourceExecutionId: null,
        },
      });
      await setRunStatus(id, "running");
      return id;
    };
    const first = await child("Design the calendar", "Calendar design");
    const second = await child("Design the inbox", "Inbox design");
    await setRunStatus(root.runId, "completed");

    // Both finalize concurrently and are HELD at the contested point: each
    // has written its own terminal state, uncommitted, and is about to read
    // family liveness. Released together, the root's row lock serializes
    // them, so the second sees the first's committed state and settles the
    // card; without the lock both would read the other as running.
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setFamilyLivenessBarrierForTest(async () => {
      arrived += 1;
      if (arrived === 2) release();
      await gate;
    });
    try {
      await Promise.all([
        finalizeRun(first, "completed", "Calendar done", 100),
        finalizeRun(second, "completed", "Inbox done", 100),
      ]);
    } finally {
      setFamilyLivenessBarrierForTest(null);
    }
    expect(arrived).toBe(2);
    const revisions = await Promise.all([first, second].map(async (id) => {
      const row = await getSlackOutbox(`slack-card:final:${TEAM}:${id}`);
      const payload = JSON.parse(row?.payload ?? "{}") as { revision?: number; blocks?: Array<{ status?: string }> };
      return { revision: payload.revision ?? 0, status: payload.blocks?.[0]?.status };
    }));
    const last = revisions.toSorted((a, b) => a.revision - b.revision).at(-1);
    expect(last?.status).toBe("complete");
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
    await setRunSandbox(runId, "sb");
    await setRunProviderSession(runId, providerSessionBinding({
      provider: "opencode",
      nativeSessionId: "ses_done",
      protocolVersion: providerProtocolIdentity(t3ProviderDrivers.opencode.descriptor.protocol),
      runtime: { kind: "sandbox", id: "sb" },
      capabilities: {} as never,
      generation: t3ProviderDrivers.opencode.descriptor.sessionGeneration as number,
    }));
    await db.execute(sql`update commands set state='dispatched' where run_id=${runId} and kind='run.create'`);

    const reconcile: ReconcileProbe = async (h) =>
      h.sessionId === "ses_done" ? { status: "completed", summary: "reconciled reply" } : { status: "unreachable" };
    const res = await recoverStaleRuns(reconcile);
    expect(res.reconciled).toBeGreaterThanOrEqual(1);

    const row = await getSlackOutbox(`slack-reply:${TEAM}:${runId}`);
    expect(row).not.toBeNull();
    const reconciled = JSON.parse(row!.payload) as { closingMarkdown?: string; text: string };
    expect(reconciled.closingMarkdown).toBe("reconciled reply");
    expect(reconciled.text).toBe("reconciled reply");
  });
});
