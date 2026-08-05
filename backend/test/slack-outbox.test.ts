import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { startSlackOutbox } from "../src/slack";
import type { DeliveryResult, SlackClient } from "../src/slack/client";
import { enqueue } from "../src/slack/outbox/repo";
import {
  enqueuePostMessage,
  getSlackOutbox,
  processDue,
  resetStuckDelivering,
  stopSlackOutboxRelay,
} from "../src/slack/outbox";
import { uid } from "./helpers";

// Durable Slack outbox: transactional enqueue → delivery worker with idempotency,
// bounded backoff, 429/Retry-After, and dead-letter. Each test builds its OWN
// recording client (passed straight to processDue) and starts from an empty
// table, so delivery is fully deterministic. The background relay is stopped so
// only the explicit processDue() calls deliver.

interface Recorder {
  client: SlackClient;
  posted: Array<{ channel: string; text: string; threadTs?: string }>;
}

/** A recording client whose delivery result is fixed for this test. */
function recorder(result: () => DeliveryResult = () => ({ ok: true })): Recorder {
  const posted: Recorder["posted"] = [];
  return {
    posted,
    client: {
      postMessage: async (m) => {
        posted.push(m);
        return result();
      },
      addReaction: async () => result(),
      setAssistantStatus: async () => {},
    },
  };
}

beforeAll(() => stopSlackOutboxRelay());
afterAll(() => startSlackOutbox()); // restart for the other slack tests' kick-driven delivery
beforeEach(async () => {
  await db.execute(sql`delete from slack_outbox`);
});

const forceDue = (key: string) =>
  db.execute(sql`update slack_outbox set next_attempt_at = now() - interval '1 second' where idempotency_key = ${key}`);

describe("durable slack outbox", () => {
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
});
