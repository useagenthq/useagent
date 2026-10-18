import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { artifacts, providerEvents } from "../src/db/schema";
import { recordProviderEvent } from "../src/runs/provider-events";
import { startSlackOutbox } from "../src/slack";
import { setSlackClientForTest, type DeliveryResult, type SlackClient } from "../src/slack/client";
import { enqueue } from "../src/slack/outbox/repo";
import { createRun, setRunStatus } from "../src/runs/repo";
import { createSlackRunResponse, findSlackRunResponse, linkSlackThread } from "../src/slack/repo";
import { markdownChunksFor } from "../src/slack/streaming";
import { getSlackCardTsByRoot } from "../src/slack/repo";
import { slackOutbox } from "../src/db/schema";
import {
  enqueuePostMessage,
  backfillSlackOutboxOrgScope,
  drainSlackDeliveryReceipts,
  getSlackOutbox,
  processDue,
  resetStuckDelivering,
  stopSlackOutboxRelay,
} from "../src/slack/outbox";
import { uid, waitFor } from "./helpers";
import { DEV_ORG_ID } from "../src/dev-org";
import { PLATFORM_EVENT_LANES } from "@useagent/agent-harness/canonical";

const ORG = DEV_ORG_ID;

// Durable Slack outbox: transactional enqueue → delivery worker with idempotency,
// bounded backoff, 429/Retry-After, and dead-letter. Each test builds its OWN
// recording client (passed straight to processDue) and starts from an empty
// table, so delivery is fully deterministic. The background relay is stopped so
// only the explicit processDue() calls deliver.

interface Recorder {
  client: SlackClient;
  posted: Array<{ channel: string; text: string; threadTs?: string }>;
  updates: Array<{ channel: string; ts: string; text: string }>;
  streams: Array<{
    op: "start" | "append" | "stop";
    channel: string;
    threadTs: string;
    messageTs?: string;
    taskDisplayMode?: string;
    recipientTeamId?: string;
    recipientUserId?: string;
    chunks?: readonly unknown[];
  }>;
  statuses: Array<{ channel: string; threadTs: string; status: "processing" | "active" }>;
  threadStatuses: Array<{ channel: string; threadTs: string; status: string; loadingMessages?: readonly string[] }>;
}

/** A recording client whose delivery result is fixed for this test. */
function recorder(result: () => DeliveryResult = () => ({ ok: true })): Recorder {
  const posted: Recorder["posted"] = [];
  const updates: Recorder["updates"] = [];
  const streams: Recorder["streams"] = [];
  const statuses: Recorder["statuses"] = [];
  const threadStatuses: Recorder["threadStatuses"] = [];
  return {
    posted,
    updates,
    streams,
    statuses,
    threadStatuses,
    client: {
      postMessage: async (m) => {
        posted.push(m);
        const res = result();
        return res.ok ? { ok: true, ts: "stream.1" } : res;
      },
      updateMessage: async (m) => {
        updates.push({ channel: m.channel, ts: m.ts, text: m.text });
        return result();
      },
      addReaction: async () => result(),
      setSessionStatus: async (s) => {
        statuses.push(s);
        return result();
      },
      setThreadStatus: async (s) => {
        threadStatuses.push(s);
        return result();
      },
      startStream: async (s) => {
        streams.push({
          op: "start",
          channel: s.channel,
          threadTs: s.threadTs,
          taskDisplayMode: s.taskDisplayMode,
          recipientTeamId: s.recipientTeamId,
          recipientUserId: s.recipientUserId,
          chunks: s.chunks,
        });
        const res = result();
        return res.ok ? { ok: true, ts: "stream.1" } : res;
      },
      appendStream: async (s) => {
        streams.push({
          op: "append",
          channel: s.channel,
          threadTs: s.threadTs,
          messageTs: s.messageTs,
          chunks: s.chunks,
        });
        return result();
      },
      stopStream: async (s) => {
        streams.push({
          op: "stop",
          channel: s.channel,
          threadTs: s.threadTs,
          messageTs: s.messageTs,
          chunks: s.chunks,
        });
        return result();
      },
      uploadFile: async () => result(),
    },
  };
}

beforeAll(() => stopSlackOutboxRelay());
afterAll(() => startSlackOutbox()); // restart for the other slack tests' kick-driven delivery
beforeEach(async () => {
  await db.execute(sql`delete from slack_outbox`);
  await db.execute(sql`delete from slack_run_responses`);
  await db.execute(sql`delete from slack_threads`);
});

const forceDue = (key: string) =>
  db.execute(sql`update slack_outbox set next_attempt_at = now() - interval '1 second' where idempotency_key = ${key}`);

async function linkedSlackRun(): Promise<{ runId: string; teamId: string; channel: string; threadTs: string }> {
  const runId = crypto.randomUUID();
  const teamId = `T${uid("team")}`;
  const channel = `C${uid("stream")}`;
  const threadTs = `${uid("ts")}.1`;
  await createRun({
    id: runId,
    prompt: "stream run",
    model: "m",
    engine: "mock",
    orgId: ORG,
    userId: null,
    parentRunId: null,
    threadId: runId,
  });
  await linkSlackThread({ teamId, channel, threadTs, rootRunId: runId, orgId: ORG });
  await createSlackRunResponse({ runId, teamId, channel, threadTs });
  return { runId, teamId, channel, threadTs };
}

describe("durable slack outbox", () => {
  test("a kick during an active pass schedules one immediate follow-up pass", async () => {
    const firstKey = uid("overlap-first");
    const secondKey = uid("overlap-second");
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const posted: string[] = [];
    const client = recorder(() => ({ ok: true })).client;
    client.postMessage = async (message) => {
      posted.push(message.text);
      if (message.text === firstKey) {
        firstStarted();
        await firstBlocked;
      }
      return { ok: true };
    };
    setSlackClientForTest(client);
    startSlackOutbox();
    try {
      await enqueuePostMessage({ channel: "C1", text: firstKey, idempotencyKey: firstKey });
      await firstStartedPromise;
      await enqueuePostMessage({ channel: "C1", text: secondKey, idempotencyKey: secondKey });
      releaseFirst();
      await waitFor(async () => posted.includes(secondKey), { timeoutMs: 1_000 });
      expect(posted).toEqual([firstKey, secondKey]);
    } finally {
      stopSlackOutboxRelay();
      setSlackClientForTest(null);
      releaseFirst();
    }
  });

  test("enqueues a committed row and delivers it exactly once", async () => {
    const key = uid("deliver");
    const rec = recorder(() => ({ ok: true }));
    expect(await enqueue({ kind: "post_message", idempotencyKey: key, payload: { channel: "C1", text: key, threadTs: "t1" } })).toBe(true);
    expect((await getSlackOutbox(key))?.state).toBe("pending");

    await processDue(rec.client);
    expect((await getSlackOutbox(key))?.state).toBe("delivered");
    expect(rec.posted).toHaveLength(1);

    // A second pass never re-delivers a delivered row.
    await processDue(rec.client);
    expect(rec.posted).toHaveLength(1);
  });

  test("enqueue is idempotent by key (same message enqueued once)", async () => {
    const key = uid("idem");
    const payload = { channel: "C", text: key };
    expect(await enqueue({ kind: "post_message", idempotencyKey: key, payload })).toBe(true);
    expect(await enqueue({ kind: "post_message", idempotencyKey: key, payload })).toBe(false);
  });

  test("a user mirror retains its retry cursor and sorts before the same run's result", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const mirrorKey = uid("user-mirror");
    const resultKey = uid("mirror-result");
    await db.transaction(async (tx) => {
      await enqueue({
        kind: "stop_stream",
        idempotencyKey: resultKey,
        payload: {
          orgId: ORG,
          teamId,
          channel,
          threadTs,
          runId,
          chunks: markdownChunksFor("done"),
          blocks: [],
          text: "result",
          fallbackChunks: ["result"],
          waitForIdempotencyKey: mirrorKey,
        },
      }, tx);
      await enqueue({
        kind: "post_message",
        idempotencyKey: mirrorKey,
        payload: {
          orgId: ORG,
          teamId,
          channel,
          threadTs,
          runId,
          messageRole: "user_mirror",
          chunks: ["From User in UseAgent:\nrequest"],
        },
      }, tx);
    });

    const ordered = recorder(() => ({ ok: true }));
    await processDue(ordered.client);
    expect(ordered.posted.map((message) => message.text)).toEqual([
      "From User in UseAgent:\nrequest",
      "result",
    ]);
    expect(await enqueue({
      kind: "post_message",
      idempotencyKey: mirrorKey,
      payload: {
        orgId: ORG,
        teamId,
        channel,
        threadTs,
        runId,
        messageRole: "user_mirror",
        chunks: ["From User in UseAgent:\nrequest"],
      },
    })).toBe(false); // delivered intent cannot be re-enqueued
  });

  test("a rate-limited user mirror holds its result until the retry succeeds", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const mirrorKey = uid("user-mirror-429");
    const resultKey = uid("mirror-result-429");
    await enqueue({
      kind: "post_message",
      idempotencyKey: mirrorKey,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, messageRole: "user_mirror", chunks: ["request"] },
    });
    await enqueue({
      kind: "stop_stream",
      idempotencyKey: resultKey,
      payload: {
        orgId: ORG, teamId, channel, threadTs, runId,
        chunks: markdownChunksFor("done"), blocks: [], text: "result",
        fallbackChunks: ["result"], waitForIdempotencyKey: mirrorKey,
      },
    });

    const rateLimited = recorder(() => ({
      ok: false,
      class: "rate_limited",
      retryAfterMs: 30_000,
      message: "http_429",
    }));
    await processDue(rateLimited.client);
    expect(rateLimited.posted.map((message) => message.text)).toEqual(["request"]);
    expect(await getSlackOutbox(mirrorKey)).toMatchObject({ state: "pending", attemptCount: 1 });
    expect(await getSlackOutbox(resultKey)).toMatchObject({
      state: "pending",
      attemptCount: 0,
      lastError: "waiting_for_user_mirror",
    });

    await forceDue(mirrorKey);
    await forceDue(resultKey);
    const retried = recorder(() => ({ ok: true }));
    await processDue(retried.client);
    expect(retried.posted.map((message) => message.text)).toEqual(["request", "result"]);
  });

  test("a permanent user-mirror failure does not strand the bot result", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const mirrorKey = uid("user-mirror-dead");
    const resultKey = uid("mirror-result-dead");
    await enqueue({
      kind: "post_message",
      idempotencyKey: mirrorKey,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, messageRole: "user_mirror", chunks: ["request"] },
    });
    await enqueue({
      kind: "stop_stream",
      idempotencyKey: resultKey,
      payload: {
        orgId: ORG, teamId, channel, threadTs, runId,
        chunks: markdownChunksFor("done"), blocks: [], text: "result",
        fallbackChunks: ["result"], waitForIdempotencyKey: mirrorKey,
      },
    });
    let calls = 0;
    const client = recorder(() =>
      calls++ === 0
        ? { ok: false, class: "permanent", message: "message_rejected" }
        : { ok: true },
    );
    await processDue(client.client);
    expect(await getSlackOutbox(mirrorKey)).toMatchObject({ state: "dead" });
    expect(await getSlackOutbox(resultKey)).toMatchObject({ state: "delivered" });
    expect(client.posted.map((message) => message.text)).toEqual(["request", "result"]);
  });

  test("the dependency fence holds when the user mirror falls beyond the 20-row claim batch", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const mirrorKey = uid("user-mirror-batch");
    const resultKey = uid("mirror-result-batch");
    await enqueue({
      kind: "post_message",
      idempotencyKey: mirrorKey,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, messageRole: "user_mirror", chunks: ["request"] },
    });
    await db.execute(sql`
      update slack_outbox set next_attempt_at = now() + interval '1 hour'
      where idempotency_key = ${mirrorKey}
    `);
    await enqueue({
      kind: "stop_stream",
      idempotencyKey: resultKey,
      payload: {
        orgId: ORG, teamId, channel, threadTs, runId,
        chunks: markdownChunksFor("done"), blocks: [], text: "result",
        fallbackChunks: ["result"], waitForIdempotencyKey: mirrorKey,
      },
    });
    for (let i = 0; i < 19; i++) {
      await enqueue({
        kind: "post_message",
        idempotencyKey: uid(`batch-filler-${i}`),
        payload: { channel: "C-filler", text: `filler-${i}` },
      });
    }

    const firstPass = recorder(() => ({ ok: true }));
    await processDue(firstPass.client);
    expect(firstPass.posted.map((message) => message.text)).not.toContain("result");
    expect(await getSlackOutbox(resultKey)).toMatchObject({ state: "pending", attemptCount: 0 });

    await forceDue(mirrorKey);
    await forceDue(resultKey);
    const secondPass = recorder(() => ({ ok: true }));
    await processDue(secondPass.client);
    expect(secondPass.posted.map((message) => message.text)).toEqual(["request", "result"]);
  });

  test("429 backs off honoring Retry-After, then delivers on retry", async () => {
    const key = uid("rl");
    await enqueue({ kind: "post_message", idempotencyKey: key, payload: { channel: "C", text: key } });

    const t0 = Date.now();
    await processDue(recorder(() => ({ ok: false, class: "rate_limited", retryAfterMs: 30_000, message: "http_429" })).client);
    const row = await getSlackOutbox(key);
    expect(row?.state).toBe("pending");
    expect(row?.errorClass).toBe("rate_limited");
    expect(row?.attemptCount).toBe(1);
    // Backed off ~Retry-After (30s) — not immediately re-deliverable.
    expect(new Date(row!.nextAttemptAt).getTime()).toBeGreaterThan(t0 + 20_000);

    // Force it due and let it succeed.
    await forceDue(key);
    await processDue(recorder(() => ({ ok: true })).client);
    expect((await getSlackOutbox(key))?.state).toBe("delivered");
  });

  test("permanent error dead-letters immediately", async () => {
    const key = uid("perm");
    await enqueue({ kind: "post_message", idempotencyKey: key, payload: { channel: "C", text: key } });

    await processDue(recorder(() => ({ ok: false, class: "permanent", message: "channel_not_found" })).client);
    const row = await getSlackOutbox(key);
    expect(row?.state).toBe("dead");
    expect(row?.errorClass).toBe("permanent");
  });

  test("a run-scoped dead letter produces a durable user-visible failure receipt", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const key = uid("visible-dead");
    await enqueue({
      kind: "set_session_status",
      idempotencyKey: key,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, status: "processing" },
    });

    await processDue(recorder(() => ({
      ok: false,
      class: "permanent",
      message: "integration_not_connected",
    })).client);
    expect(await getSlackOutbox(key)).toMatchObject({
      state: "dead",
      receiptEmittedAt: expect.any(Date),
    });
    const receipts = await db
      .select({ payload: providerEvents.payload })
      .from(providerEvents)
      .where(and(
        eq(providerEvents.runId, runId),
        eq(providerEvents.eventType, "delivery.failed"),
      ));
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0]?.payload ?? "{}")).toMatchObject({
      destination: "slack",
      delivery_kind: "set_session_status",
      error_class: "permanent",
      reason: "integration_not_connected",
    });

    // Crash window: the event committed but the row cursor did not. Replay is
    // idempotent by event id and repairs the cursor without a duplicate receipt.
    await db.execute(sql`update slack_outbox set receipt_emitted_at = null where idempotency_key = ${key}`);
    await drainSlackDeliveryReceipts();
    expect((await getSlackOutbox(key))?.receiptEmittedAt).toBeInstanceOf(Date);
    expect(await db
      .select({ id: providerEvents.id })
      .from(providerEvents)
      .where(and(
        eq(providerEvents.runId, runId),
        eq(providerEvents.eventType, "delivery.failed"),
      ))).toHaveLength(1);
  });

  test("transient errors retry with backoff then dead-letter when exhausted", async () => {
    const key = uid("exhaust");
    await enqueue({ kind: "post_message", idempotencyKey: key, payload: { channel: "C", text: key } });
    await db.execute(sql`update slack_outbox set max_attempts = 2 where idempotency_key = ${key}`);
    const flaky = recorder(() => ({ ok: false, class: "transient", message: "internal_error" })).client;

    await processDue(flaky); // attempt 1 → retry (1 < 2)
    expect((await getSlackOutbox(key))?.state).toBe("pending");
    await forceDue(key);
    await processDue(flaky); // attempt 2 → exhausted → dead
    const row = await getSlackOutbox(key);
    expect(row?.state).toBe("dead");
    expect(row?.attemptCount).toBe(2);
    expect(row?.errorClass).toBe("transient");
  });

  test("resetStuckDelivering re-arms an orphaned mid-delivery row (boot recovery)", async () => {
    const key = uid("stuck");
    await enqueue({ kind: "post_message", idempotencyKey: key, payload: { channel: "C", text: key } });
    // Simulate a crash after claiming but before delivery.
    await db.execute(sql`update slack_outbox set state = 'delivering' where idempotency_key = ${key}`);

    expect(await resetStuckDelivering()).toBeGreaterThanOrEqual(1);
    expect((await getSlackOutbox(key))?.state).toBe("pending");

    await processDue(recorder(() => ({ ok: true })).client);
    expect((await getSlackOutbox(key))?.state).toBe("delivered");
  });

  test("facade enqueuePostMessage enqueues a durable row that delivers", async () => {
    const key = uid("wire");
    await enqueuePostMessage({ idempotencyKey: key, channel: "C", text: key, threadTs: "tt" });
    expect((await getSlackOutbox(key))?.state).toBe("pending");

    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    expect((await getSlackOutbox(key))?.state).toBe("delivered");
    expect(rec.posted.some((p) => p.text === key)).toBe(true);
  });

  test("team-scoped delivery fails closed when the workspace no longer matches its queued org", async () => {
    const key = uid("rebound");
    await enqueuePostMessage({ idempotencyKey: key, orgId: ORG, teamId: "T1", channel: "C1", text: key });
    const rec = recorder(() => ({ ok: true }));
    await processDue(null, async (_teamId, expectedOrgId) => expectedOrgId === "org-rebound" ? rec.client : null);
    expect((await getSlackOutbox(key))?.state).toBe("dead");
    expect(rec.posted).toHaveLength(0);
  });

  test("boot backfill preserves a pre-upgrade terminal answer from durable run ownership", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    await setRunStatus(runId, "completed");
    const key = uid("legacy-terminal");
    await db.execute(sql`
      insert into slack_outbox (id, idempotency_key, kind, payload)
      values (
        ${crypto.randomUUID()},
        ${key},
        'stop_stream',
        ${JSON.stringify({
          teamId,
          channel,
          threadTs,
          runId,
          chunks: markdownChunksFor("done"),
          blocks: [],
          text: "final answer",
          fallbackChunks: ["final answer"],
        })}
      )`);

    expect(await backfillSlackOutboxOrgScope()).toBe(1);
    expect(JSON.parse((await getSlackOutbox(key))?.payload ?? "{}")).toMatchObject({ orgId: ORG });
    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    expect(rec.posted).toEqual([{ channel, text: "final answer", threadTs }]);
  });

  test("boot backfill dead-letters malformed legacy JSON without blocking valid repair", async () => {
    const malformedKey = uid("malformed-legacy");
    await db.execute(sql`
      insert into slack_outbox (id, idempotency_key, kind, payload)
      values (${crypto.randomUUID()}, ${malformedKey}, 'post_message', '{')`);

    expect(await backfillSlackOutboxOrgScope()).toBe(0);
    expect(await getSlackOutbox(malformedKey)).toMatchObject({
      state: "dead",
      lastError: "invalid_payload",
    });
  });

  test("a dead upload emits failure only, never artifact delivered", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const key = uid("dead-upload");
    await db.execute(sql`
      insert into slack_outbox
        (id, idempotency_key, kind, payload, state, error_class, last_error)
      values (
        ${crypto.randomUUID()}, ${key}, 'upload_file',
        ${JSON.stringify({ orgId: ORG, teamId, channel, threadTs, deliveryRunId: runId })},
        'dead', 'permanent', 'artifact_bytes_missing'
      )`);

    await drainSlackDeliveryReceipts();
    const events = await db
      .select({ eventType: providerEvents.eventType })
      .from(providerEvents)
      .where(eq(providerEvents.runId, runId));
    expect(events).toEqual([{ eventType: "delivery.failed" }]);
    expect((await getSlackOutbox(key))?.receiptEmittedAt).toBeInstanceOf(Date);
  });

  test("legacy delivered upload replay reuses the deployed receipt identity", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const artifactId = crypto.randomUUID();
    await db.insert(artifacts).values({
      id: artifactId,
      orgId: ORG,
      runId,
      threadId: runId,
      sourcePath: "/legacy/report.pdf",
      name: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 10,
      sha256: "a".repeat(64),
      storageKey: "a".repeat(64),
    });
    const deployedEventId = `artifact.delivered:${runId}:${artifactId}`;
    await recordProviderEvent({
      id: deployedEventId,
      runId,
      threadId: runId,
      provider: PLATFORM_EVENT_LANES.platform,
      eventType: "artifact.delivered",
      payload: {
        id: artifactId,
        name: "report.pdf",
        content_type: "application/pdf",
        size_bytes: 10,
        sha256: "a".repeat(64),
        destination: "slack",
      },
    }, { critical: true, required: true });
    const key = uid("legacy-upload-receipt");
    await db.execute(sql`
      insert into slack_outbox (id, idempotency_key, kind, payload, state)
      values (
        ${crypto.randomUUID()}, ${key}, 'upload_file',
        ${JSON.stringify({ orgId: ORG, teamId, channel, threadTs, artifactId, filename: "report.pdf", size: 10 })},
        'delivered'
      )`);

    await drainSlackDeliveryReceipts();
    expect(await db
      .select({ id: providerEvents.id })
      .from(providerEvents)
      .where(and(
        eq(providerEvents.runId, runId),
        eq(providerEvents.eventType, "artifact.delivered"),
      ))).toEqual([{ id: deployedEventId }]);
    expect((await getSlackOutbox(key))?.receiptEmittedAt).toBeInstanceOf(Date);
  });
});

describe("chunked reply delivery", () => {
  test("chunks post sequentially, in order, all into the same thread", async () => {
    const key = uid("chunks");
    await enqueue({
      kind: "post_message",
      idempotencyKey: key,
      payload: { channel: "C9", chunks: ["head", "middle", "tail"], threadTs: "9.1" },
    });
    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    expect((await getSlackOutbox(key))?.state).toBe("delivered");
    expect(rec.posted.map((p) => p.text)).toEqual(["head", "middle", "tail"]);
    for (const p of rec.posted) expect(p.threadTs).toBe("9.1");
  });

  test("a mid-sequence failure retries from the FAILED chunk, not from the start", async () => {
    const key = uid("resume");
    await enqueue({
      kind: "post_message",
      idempotencyKey: key,
      payload: { channel: "C9", chunks: ["one", "two", "three"], threadTs: "9.2" },
    });
    // First pass: chunk 1 delivers, chunk 2 fails transiently.
    let calls = 0;
    const flaky = recorder(() => (++calls === 2 ? { ok: false, class: "transient", message: "boom" } : { ok: true }));
    await processDue(flaky.client);
    const row = await getSlackOutbox(key);
    expect(row?.state).toBe("pending");
    // The chunk cursor persisted: only the undelivered chunks remain.
    expect((JSON.parse(row!.payload) as { chunks: string[] }).chunks).toEqual(["two", "three"]);

    await forceDue(key);
    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    expect((await getSlackOutbox(key))?.state).toBe("delivered");
    expect(rec.posted.map((p) => p.text)).toEqual(["two", "three"]); // "one" never re-posts
  });
});

describe("native slack streaming outbox", () => {
  test("start_stream opens a native stream (timeline mode + recipients) and stores its ts", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const key = uid("stream-start");
    await enqueue({
      kind: "start_stream",
      idempotencyKey: key,
      payload: {
        orgId: ORG,
        channel,
        teamId,
        threadTs,
        runId,
        taskDisplayMode: "timeline",
        chunks: markdownChunksFor("Queued"),
        recipientTeamId: teamId,
        recipientUserId: "U-ASKER",
        fallbackBlocks: [{ type: "section", text: { type: "mrkdwn", text: "Queued" } }],
        fallbackText: "Queued",
      },
    });

    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    expect((await getSlackOutbox(key))?.state).toBe("delivered");
    expect(rec.streams.map((s) => s.op)).toEqual(["start"]);
    expect(rec.streams[0]?.taskDisplayMode).toBe("timeline");
    expect(rec.streams[0]?.recipientTeamId).toBe(teamId);
    expect(rec.streams[0]?.recipientUserId).toBe("U-ASKER");
    expect(rec.streams[0]?.chunks).toEqual(markdownChunksFor("Queued"));
    const response = await findSlackRunResponse(runId);
    expect(response?.nativeStreamTs).toBe("stream.1");
    // The opening markdown is narration: the offset fence starts after it.
    expect(response?.streamedChars).toBe("Queued".length);
  });

  test("append_stream targets the stored ts and NORMALIZES pre-migration chunk shapes", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    await enqueue({
      kind: "start_stream",
      idempotencyKey: uid("stream-start"),
      payload: {
        orgId: ORG,
        channel,
        teamId,
        threadTs,
        runId,
        // Pre-migration row: retired mode + legacy markdown field. Delivery must
        // translate both to the documented wire contract.
        taskDisplayMode: "task_update",
        chunks: [{ type: "markdown_text", markdown_text: "Queued" }],
        fallbackBlocks: [],
        fallbackText: "Queued",
      },
    });
    const startRec = recorder(() => ({ ok: true }));
    await processDue(startRec.client);
    expect(startRec.streams[0]?.taskDisplayMode).toBe("timeline");
    expect(startRec.streams[0]?.chunks).toEqual([{ type: "markdown_text", text: "Queued" }]);

    const key = uid("stream-append");
    await enqueue({
      kind: "append_stream",
      idempotencyKey: key,
      payload: {
        orgId: ORG,
        channel,
        teamId,
        threadTs,
        runId,
        // Pre-migration nested task shape -> flat documented shape at delivery.
        chunks: [
          {
            type: "task_update",
            task: { task_id: "step_1", title: "Ran command", status: "in_progress" },
          },
        ],
        fallbackBlocks: [{ type: "section", text: { type: "mrkdwn", text: "Running" } }],
        fallbackText: "Running",
      },
    });

    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    expect((await getSlackOutbox(key))?.state).toBe("delivered");
    expect(rec.streams).toHaveLength(1);
    expect(rec.streams[0]).toMatchObject({
      op: "append",
      channel,
      threadTs,
      messageTs: "stream.1",
      chunks: [{ type: "task_update", id: "step_1", title: "Ran command", status: "in_progress" }],
    });
  });

  test("plan display mode passes plan_update chunks through unchanged", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const key = uid("stream-plan");
    await enqueue({
      kind: "start_stream",
      idempotencyKey: key,
      payload: {
        orgId: ORG,
        channel,
        teamId,
        threadTs,
        runId,
        taskDisplayMode: "plan",
        chunks: [{ type: "plan_update", title: "Plan 0/3: Inspect request" }],
        fallbackBlocks: [],
        fallbackText: "Planning",
      },
    });

    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    expect((await getSlackOutbox(key))?.state).toBe("delivered");
    expect(rec.streams[0]?.taskDisplayMode).toBe("plan");
    expect(rec.streams[0]?.chunks).toEqual([
      { type: "plan_update", title: "Plan 0/3: Inspect request" },
    ]);
  });

  test("a transient start_stream API error still falls back ONCE to a plain message", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const key = uid("stream-transient-start");
    await enqueue({
      kind: "start_stream",
      idempotencyKey: key,
      payload: {
        orgId: ORG,
        channel,
        teamId,
        threadTs,
        runId,
        taskDisplayMode: "timeline",
        chunks: markdownChunksFor("Queued"),
        fallbackText: "Queued",
      },
    });
    const rec = recorder(() => ({ ok: true }));
    rec.client.startStream = async () => ({ ok: false, class: "transient", message: "feature_not_enabled" });
    await processDue(rec.client);
    const row = await getSlackOutbox(key);
    expect(row?.state).toBe("delivered"); // one attempt, no retry storm
    expect(row?.attemptCount).toBe(0);
    // The fallback is the opening text as a plain message: no card chrome.
    expect(rec.posted).toEqual([{ channel, text: "Queued", threadTs }]);
    const response = await findSlackRunResponse(runId);
    expect(response?.nativeStreamTs).toBeNull();
    expect(response?.fallbackMessageTs).toBe("stream.1");
  });

  test("set_thread_status delivers the calm phrases and the empty-string clear", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const setKey = uid("thread-status-set");
    const clearKey = uid("thread-status-clear");
    await enqueue({
      kind: "set_thread_status",
      idempotencyKey: setKey,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, status: "Working on it", loadingMessages: ["Working on it", "Nearly there"] },
    });
    await enqueue({
      kind: "set_thread_status",
      idempotencyKey: clearKey,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, status: "" },
    });

    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    expect((await getSlackOutbox(setKey))?.state).toBe("delivered");
    expect((await getSlackOutbox(clearKey))?.state).toBe("delivered");
    expect(rec.threadStatuses.filter((entry) => (
      entry.channel === channel && entry.threadTs === threadTs
    ))).toEqual([
      { channel, threadTs, status: "Working on it", loadingMessages: ["Working on it", "Nearly there"] },
      { channel, threadTs, status: "" },
    ]);
  });

  test("start_stream fallback stores only fallback ts and append_stream updates that fallback", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    await enqueue({
      kind: "start_stream",
      idempotencyKey: uid("stream-fallback-start"),
      payload: {
        orgId: ORG,
        channel,
        teamId,
        threadTs,
        runId,
        taskDisplayMode: "task_update",
        chunks: [{ type: "markdown_text", markdown_text: "Queued" }],
        fallbackBlocks: [{ type: "section", text: { type: "mrkdwn", text: "Queued" } }],
        fallbackText: "Queued",
      },
    });
    const startRec = recorder(() => ({ ok: true }));
    startRec.client.startStream = async (s) => {
      startRec.streams.push({ op: "start", channel: s.channel, threadTs: s.threadTs });
      return { ok: false, class: "permanent", message: "method_not_supported" };
    };
    await processDue(startRec.client);
    const response = await findSlackRunResponse(runId);
    expect(response?.nativeStreamTs).toBeNull();
    expect(response?.fallbackMessageTs).toBe("stream.1");

    const appendKey = uid("stream-fallback-append");
    await enqueue({
      kind: "append_stream",
      idempotencyKey: appendKey,
      payload: {
        orgId: ORG,
        channel,
        teamId,
        threadTs,
        runId,
        chunks: [{ type: "task_update", task: { task_id: "step_2", title: "Ran command", status: "in_progress" } }],
        fallbackBlocks: [{ type: "section", text: { type: "mrkdwn", text: "Running" } }],
        fallbackText: "Running",
      },
    });
    const appendRec = recorder(() => ({ ok: true }));
    await processDue(appendRec.client);
    expect((await getSlackOutbox(appendKey))?.state).toBe("delivered");
    expect(appendRec.streams).toHaveLength(0);
    expect(appendRec.updates).toEqual([{ channel, ts: "stream.1", text: "Running" }]);
  });

  test("stop_stream after start fallback updates fallback instead of stopping native stream", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    await enqueue({
      kind: "start_stream",
      idempotencyKey: uid("stream-stop-after-fallback-start"),
      payload: {
        orgId: ORG,
        channel,
        teamId,
        threadTs,
        runId,
        taskDisplayMode: "task_update",
        chunks: [{ type: "markdown_text", markdown_text: "Queued" }],
        fallbackBlocks: [],
        fallbackText: "Queued",
      },
    });
    const startRec = recorder(() => ({ ok: true }));
    startRec.client.startStream = async (s) => {
      startRec.streams.push({ op: "start", channel: s.channel, threadTs: s.threadTs });
      return { ok: false, class: "permanent", message: "method_not_supported" };
    };
    await processDue(startRec.client);

    const stopKey = uid("stream-stop-after-fallback");
    await enqueue({
      kind: "stop_stream",
      idempotencyKey: stopKey,
      payload: {
        orgId: ORG,
        channel,
        teamId,
        threadTs,
        runId,
        chunks: [{ type: "markdown_text", markdown_text: "answer" }],
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "answer" } }],
        text: "answer",
        fallbackChunks: ["answer"],
      },
    });
    const stopRec = recorder(() => ({ ok: true }));
    await processDue(stopRec.client);
    expect((await getSlackOutbox(stopKey))?.state).toBe("delivered");
    expect(stopRec.streams).toHaveLength(0);
    expect(stopRec.updates).toEqual([{ channel, ts: "stream.1", text: "answer" }]);
    expect(stopRec.posted).toHaveLength(0);
  });

  test("stop_stream falls back to a plain chunked reply when no message ts exists", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const key = uid("stream-stop-fallback");
    await enqueue({
      kind: "stop_stream",
      idempotencyKey: key,
      payload: {
        orgId: ORG,
        channel,
        teamId,
        threadTs,
        runId,
        chunks: [{ type: "markdown_text", markdown_text: "answer" }],
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "answer" } }],
        text: "answer",
        fallbackChunks: ["answer"],
      },
    });

    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    expect((await getSlackOutbox(key))?.state).toBe("delivered");
    expect(rec.streams).toHaveLength(0);
    expect(rec.posted).toEqual([{ channel, text: "answer", threadTs }]);
  });

  test("terminal truth drops delayed live rows but still delivers terminal clears", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    await setRunStatus(runId, "completed");
    const key = uid("session-status");
    await enqueue({
      kind: "set_session_status",
      idempotencyKey: key,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, status: "processing" },
    });
    await enqueue({
      kind: "append_stream",
      idempotencyKey: uid("late-append"),
      payload: { orgId: ORG, teamId, channel, threadTs, runId, chunks: markdownChunksFor("late"), fallbackBlocks: [], fallbackText: "late" },
    });
    await enqueue({
      kind: "set_thread_status",
      idempotencyKey: uid("terminal-clear"),
      payload: { orgId: ORG, teamId, channel: "D1", threadTs, runId, status: "" },
    });

    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    expect((await getSlackOutbox(key))?.state).toBe("delivered");
    expect(rec.statuses).toHaveLength(0);
    expect(rec.streams).toHaveLength(0);
    expect(rec.threadStatuses).toEqual([{ channel: "D1", threadTs, status: "" }]);
  });

  test("a stop with nothing to close but a long answer fits the outbox: the fallback chunks shed, nothing throws", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const key = uid("stop-long-fallback");
    const fallbackChunks = Array.from({ length: 15 }, (_, i) => `${i}`.padEnd(3_900, "x"));
    await enqueue({
      kind: "stop_stream",
      idempotencyKey: key,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, chunks: [], narrationText: "", text: "head", fallbackChunks },
    });
    const row = await getSlackOutbox(key);
    expect(row).not.toBeNull();
    expect(row!.payload.length).toBeLessThanOrEqual(48_000);
    const stored = JSON.parse(row!.payload) as { fallbackChunks: string[] };
    expect(stored.fallbackChunks.length).toBeGreaterThan(0);
    expect(stored.fallbackChunks.length).toBeLessThan(15);
    expect(stored.fallbackChunks.at(-1)).toContain("truncated");
  });

  test("a replayed opening neither starts a second stream nor counts its text twice", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const key = uid("stream-replay");
    await enqueue({
      kind: "start_stream",
      idempotencyKey: key,
      payload: { orgId: ORG, channel, teamId, threadTs, runId, taskDisplayMode: "timeline", chunks: markdownChunksFor("Hello "), fallbackText: "Hello " },
    });
    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    expect(rec.streams.filter((s) => s.op === "start")).toHaveLength(1);
    expect((await findSlackRunResponse(runId))?.streamedChars).toBe(6);
    // A crash between Slack accepting the opening and the row being marked
    // delivered replays the row.
    await db.update(slackOutbox).set({ state: "pending", nextAttemptAt: new Date(0) }).where(eq(slackOutbox.idempotencyKey, key));
    await processDue(rec.client);
    expect((await getSlackOutbox(key))?.state).toBe("delivered");
    expect(rec.streams.filter((s) => s.op === "start")).toHaveLength(1);
    const response = await findSlackRunResponse(runId);
    expect(response?.nativeStreamTs).toBe("stream.1");
    expect(response?.streamedChars).toBe(6);
  });

  test("card revisions apply only when newer, except a turn's own terminal revision settling its late live one", async () => {
    process.env.SLACK_CARD_PACE_MS = "0";
    try {
      const { runId, teamId, channel, threadTs } = await linkedSlackRun();
      const card = (status: string, output?: string) => ({
        blocks: [{ type: "task_card", task_id: "thread", title: "t", status, ...(output ? { output } : {}) }],
        text: "t",
      });
      const base = { orgId: ORG, teamId, channel, threadTs, rootRunId: runId };
      await enqueue({ kind: "post_card", idempotencyKey: uid("card-post"), payload: { ...base, ...card("in_progress") } });
      const rec = recorder(() => ({ ok: true }));
      await processDue(rec.client);
      // Turn B's live revision lands first.
      await enqueue({ kind: "update_card", idempotencyKey: uid("card-b-live"), payload: { ...base, runId: "turn-b", revision: 20, live: true, ...card("in_progress", "Ran a command") } });
      await processDue(rec.client);
      expect(rec.updates).toHaveLength(1);
      // Turn A's delayed terminal revision is older: the shared card keeps B's state.
      const aFinal = uid("card-a-final");
      await enqueue({ kind: "update_card", idempotencyKey: aFinal, payload: { ...base, runId: "turn-a", revision: 10, ...card("complete") } });
      await processDue(rec.client);
      expect((await getSlackOutbox(aFinal))?.state).toBe("delivered");
      expect(rec.updates).toHaveLength(1);
      expect((await getSlackCardTsByRoot(runId))?.cardRevision).toBe(20);
      // B's own terminal revision, enqueued before its late live one, still settles the card.
      await enqueue({ kind: "update_card", idempotencyKey: uid("card-b-final"), payload: { ...base, runId: "turn-b", revision: 15, ...card("complete") } });
      await processDue(rec.client);
      expect(rec.updates).toHaveLength(2);
      const thread = await getSlackCardTsByRoot(runId);
      expect(thread?.cardRevision).toBe(20); // the high-water mark never falls
      expect(thread?.cardAppliedRevision).toBe(15); // the card shows B's terminal state
      expect(thread?.cardRevisionRunId).toBe("turn-b");
      // A replay of that terminal row (its update persisted, the row not yet
      // acknowledged) is already applied: no redelivery, no pacing bypass.
      const replay = uid("card-b-final-replay");
      await enqueue({ kind: "update_card", idempotencyKey: replay, payload: { ...base, runId: "turn-b", revision: 15, ...card("complete") } });
      await processDue(rec.client);
      expect((await getSlackOutbox(replay))?.state).toBe("delivered");
      expect(rec.updates).toHaveLength(2);
      // The high-water mark stayed at 20 while the applied identity is 15/B:
      // an older turn's delayed revision is still superseded, even after the
      // card had to be reposted.
      expect(thread?.cardRevision).toBe(20);
      expect(thread?.cardAppliedRevision).toBe(15);
      rec.client.updateMessage = async () => ({ ok: false, class: "permanent", message: "message_not_found" });
      await enqueue({ kind: "update_card", idempotencyKey: uid("card-b-repost"), payload: { ...base, runId: "turn-b", revision: 25, ...card("complete") } });
      await processDue(rec.client);
      expect(rec.posted).toHaveLength(2); // the card, then its repost
      const stale = uid("card-a-stale");
      await enqueue({ kind: "update_card", idempotencyKey: stale, payload: { ...base, runId: "turn-a", revision: 18, live: true, ...card("in_progress", "Ran a command") } });
      await processDue(rec.client);
      expect((await getSlackOutbox(stale))?.state).toBe("delivered");
      expect(rec.posted).toHaveLength(2);
      expect(rec.updates).toHaveLength(2);
    } finally {
      delete process.env.SLACK_CARD_PACE_MS;
    }
  });

  test("card revisions are paced: one within the window waits its turn without spending an attempt", async () => {
    process.env.SLACK_CARD_PACE_MS = "400";
    try {
      const { runId, teamId, channel, threadTs } = await linkedSlackRun();
      const blocks = [{ type: "task_card", task_id: "thread", title: "t", status: "in_progress" }];
      const base = { orgId: ORG, teamId, channel, threadTs, rootRunId: runId, blocks, text: "t" };
      await enqueue({ kind: "post_card", idempotencyKey: uid("card-post"), payload: base });
      const rec = recorder(() => ({ ok: true }));
      await processDue(rec.client);
      await new Promise((r) => setTimeout(r, 450));
      await enqueue({ kind: "update_card", idempotencyKey: uid("card-r1"), payload: { ...base, runId, revision: 1, live: true } });
      await processDue(rec.client);
      expect(rec.updates).toHaveLength(1);
      const second = uid("card-r2");
      await enqueue({ kind: "update_card", idempotencyKey: second, payload: { ...base, runId, revision: 2, live: true } });
      await processDue(rec.client);
      const paced = await getSlackOutbox(second);
      expect(paced?.state).toBe("pending");
      expect(paced?.attemptCount).toBe(0);
      expect(paced?.lastError).toBe("card_paced");
      expect(rec.updates).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 450));
      await processDue(rec.client);
      expect((await getSlackOutbox(second))?.state).toBe("delivered");
      expect(rec.updates).toHaveLength(2);
    } finally {
      delete process.env.SLACK_CARD_PACE_MS;
    }
  });

  test("an answer's tails post in order: a tail waits for the tail before it, not only for the closed stream", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    const stopKey = uid("tail-stop");
    await enqueue({
      kind: "stop_stream",
      idempotencyKey: stopKey,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, chunks: [], narrationText: "", closingMarkdown: "head", text: "head", fallbackChunks: ["head"] },
    });
    const tail0 = uid("tail-0");
    const tail1 = uid("tail-1");
    await enqueue({
      kind: "post_message",
      idempotencyKey: tail0,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, chunks: ["tail zero"], messageRole: "reply_tail", part: 0, waitForIdempotencyKey: stopKey },
    });
    await enqueue({
      kind: "post_message",
      idempotencyKey: tail1,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, chunks: ["tail one"], messageRole: "reply_tail", part: 1, waitForIdempotencyKey: tail0 },
    });
    // The head posts; tail zero fails once, transiently.
    const rec = recorder(() => ({ ok: true }));
    const post = rec.client.postMessage;
    rec.client.postMessage = async (m) => (m.text === "tail zero" && !rec.posted.some((p) => p.text === "tail zero")
      ? (rec.posted.push(m), { ok: false, class: "transient", message: "internal_error" })
      : post(m));
    await processDue(rec.client);
    expect(rec.posted.map((m) => m.text)).toEqual(["head", "tail zero"]);
    expect((await getSlackOutbox(tail0))?.state).toBe("pending");
    // Tail one waited on tail zero instead of overtaking it.
    expect((await getSlackOutbox(tail1))?.state).toBe("pending");
    // Both rows come due (the deferral is a short wait): tail zero retries first.
    await db.update(slackOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(slackOutbox.idempotencyKey, tail0));
    await processDue(rec.client);
    await db.update(slackOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(slackOutbox.idempotencyKey, tail1));
    await processDue(rec.client);
    expect(rec.posted.map((m) => m.text)).toEqual(["head", "tail zero", "tail zero", "tail one"]);
    expect((await getSlackOutbox(tail1))?.state).toBe("delivered");
  });

  test("a dead head dead-letters the reply tails behind it instead of posting fragments", async () => {
    const { runId, teamId, channel, threadTs } = await linkedSlackRun();
    // A stop row that can never deliver (no text): it dead-letters at once.
    const stopKey = uid("dead-stop");
    await enqueue({
      kind: "stop_stream",
      idempotencyKey: stopKey,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, chunks: [], narrationText: "", closingMarkdown: "" },
    });
    const tail0 = uid("dead-tail-0");
    const tail1 = uid("dead-tail-1");
    await enqueue({
      kind: "post_message",
      idempotencyKey: tail0,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, chunks: ["tail zero"], messageRole: "reply_tail", part: 0, waitForIdempotencyKey: stopKey },
    });
    await enqueue({
      kind: "post_message",
      idempotencyKey: tail1,
      payload: { orgId: ORG, teamId, channel, threadTs, runId, chunks: ["tail one"], messageRole: "reply_tail", part: 1, waitForIdempotencyKey: tail0 },
    });
    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    await db.update(slackOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(slackOutbox.idempotencyKey, tail1));
    await processDue(rec.client);
    expect((await getSlackOutbox(stopKey))?.state).toBe("dead");
    expect((await getSlackOutbox(tail0))?.state).toBe("dead");
    expect((await getSlackOutbox(tail0))?.lastError).toBe("reply_tail_predecessor_dead");
    expect((await getSlackOutbox(tail1))?.state).toBe("dead");
    expect(rec.posted).toHaveLength(0);
  });
});
