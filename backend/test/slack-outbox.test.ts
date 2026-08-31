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
import { openingStreamChunks } from "../src/slack/streaming";
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

const ORG = "org-skynet-dev";

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
  threadStatuses: Array<{ channel: string; threadTs: string; status: string }>;
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
          chunks: openingStreamChunks("done"),
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
      provider: "skynet",
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
        chunks: openingStreamChunks("Queued"),
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
    expect(rec.streams[0]?.chunks).toEqual(openingStreamChunks("Queued"));
    expect((await findSlackRunResponse(runId))?.nativeStreamTs).toBe("stream.1");
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

  test("a transient start_stream API error still falls back ONCE to the card", async () => {
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
        chunks: openingStreamChunks("Queued"),
        fallbackBlocks: [{ type: "section", text: { type: "mrkdwn", text: "Queued" } }],
        fallbackText: "Queued",
      },
    });
    const rec = recorder(() => ({ ok: true }));
    rec.client.startStream = async () => ({ ok: false, class: "transient", message: "feature_not_enabled" });
    await processDue(rec.client);
    const row = await getSlackOutbox(key);
    expect(row?.state).toBe("delivered"); // one attempt, no retry storm
    expect(row?.attemptCount).toBe(0);
    expect(rec.posted).toHaveLength(1);
    const response = await findSlackRunResponse(runId);
    expect(response?.nativeStreamTs).toBeNull();
    expect(response?.fallbackMessageTs).toBe("stream.1");
  });

  test("set_thread_status delivers free text and the empty-string clear", async () => {
    const { runId, teamId } = await linkedSlackRun();
    const setKey = uid("thread-status-set");
    const clearKey = uid("thread-status-clear");
    await enqueue({
      kind: "set_thread_status",
      idempotencyKey: setKey,
      payload: { orgId: ORG, teamId, channel: "D1", threadTs: "1.1", runId, status: "is working: cloning repo" },
    });
    await enqueue({
      kind: "set_thread_status",
      idempotencyKey: clearKey,
      payload: { orgId: ORG, teamId, channel: "D1", threadTs: "1.1", runId, status: "" },
    });

    const rec = recorder(() => ({ ok: true }));
    await processDue(rec.client);
    expect((await getSlackOutbox(setKey))?.state).toBe("delivered");
    expect((await getSlackOutbox(clearKey))?.state).toBe("delivered");
    expect(rec.threadStatuses).toEqual([
      { channel: "D1", threadTs: "1.1", status: "is working: cloning repo" },
      { channel: "D1", threadTs: "1.1", status: "" },
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
      payload: { orgId: ORG, teamId, channel, threadTs, runId, chunks: openingStreamChunks("late"), fallbackBlocks: [], fallbackText: "late" },
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
});
