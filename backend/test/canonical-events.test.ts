// Phase 1 slice-3 gate: durable canonical persistence with (1) persist-before-publish,
// (2) an IMMUTABLE thread-wide delivery cursor separate from per-run source order,
// (3) append-only revisions, and (4) THREAD-channel publish/subscribe. The headline
// proof is the two-run reconnect: after the first run's final cursor, replay returns
// EVERY event from a SECOND run created while the SSE stayed open. DB-backed (skynet_test).

import { describe, expect, test, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import {
  loadCanonicalThread,
  persistAndPublish,
  persistCanonicalEvents,
  subscribeCanonicalThread,
  type DeliveredCanonicalEvent,
} from "../src/runs/canonical-events";
import { translateOpenCode, type OpenCodeFrame } from "../src/engines/opencode-canonical";
import { waitFor } from "./helpers"; // side-effect: imports src/index -> migrate

const THREAD = `cet_${crypto.randomUUID()}`;
const R1 = THREAD; // root run id == thread id (convention)
const R2 = `cet_${crypto.randomUUID()}`;

beforeAll(async () => {
  await waitFor(() => true, 1);
  await db.insert(runs).values([
    { id: R1, prompt: "run1", model: "claude-haiku-4-5", engine: "opencode", status: "completed", threadId: THREAD },
    { id: R2, prompt: "run2", model: "claude-haiku-4-5", engine: "opencode", status: "completed", threadId: THREAD, parentRunId: R1 },
  ]).onConflictDoNothing();
});

function eventsFor(runId: string, tag: string) {
  const frames: OpenCodeFrame[] = [
    { eventId: `${tag}-t`, seq: 0, provider: "opencode", eventType: "part.text",
      native: { sessionId: "ses_a", parentSessionId: null, messageId: `${tag}-m`, partId: `${tag}-p1`, callId: null }, payload: { text: tag } },
    { eventId: `${tag}-tool`, seq: 1, provider: "opencode", eventType: "part.tool.completed",
      native: { sessionId: "ses_a", parentSessionId: null, messageId: `${tag}-m`, partId: `${tag}-p2`, callId: `${tag}-call` }, payload: { type: "tool", tool: "bash" } },
  ];
  return translateOpenCode(frames, { runId, threadId: THREAD }).events;
}

describe("canonical-events: persist-before-publish + immutable thread delivery cursor", () => {
  test("PERSIST-BEFORE-PUBLISH on the THREAD channel: row exists when subscriber fires", async () => {
    let persisted: boolean | null = null;
    const unsub = subscribeCanonicalThread(THREAD, async (e) => {
      if (persisted !== null) return;
      const rows = (await db.execute(sql`select 1 from canonical_events where delivery_seq = ${e.deliverySeq}`)) as unknown[];
      persisted = rows.length > 0;
    });
    await persistAndPublish(eventsFor(R1, "r1a"));
    await waitFor(() => persisted !== null, 2000);
    unsub();
    expect(persisted).toBe(true);
  });

  test("append-only revision: re-emitting an eventId adds a NEW row, never mutates the delivered one", async () => {
    const [first] = await persistCanonicalEvents(eventsFor(R1, "rev").slice(0, 1));
    const [second] = await persistCanonicalEvents(eventsFor(R1, "rev").slice(0, 1)); // same eventId
    expect(second.revision).toBe(first.revision + 1);
    expect(second.deliverySeq).toBeGreaterThan(first.deliverySeq); // immutable: appended, not reordered
    // the original delivered row is untouched
    const orig = (await db.execute(sql`select revision from canonical_events where delivery_seq = ${first.deliverySeq}`)) as { revision: number }[];
    expect(Number(orig[0].revision)).toBe(first.revision);
  });

  test("TWO-RUN reconnect: after run1's final cursor, replay returns EVERY run2 event", async () => {
    // fresh subscriber that stays open across both runs (run2 is created live).
    const live: DeliveredCanonicalEvent[] = [];
    const unsub = subscribeCanonicalThread(THREAD, (e) => live.push(e));

    const run1 = await persistAndPublish(eventsFor(R1, "run1"));
    const run1Final = Math.max(...run1.map((e) => e.deliverySeq));

    // A SECOND run in the same thread, created while the SSE is still open.
    const run2 = await persistAndPublish(eventsFor(R2, "run2"));
    unsub();

    // thread-wide monotonic: every run2 cursor is greater than every run1 cursor.
    expect(Math.min(...run2.map((e) => e.deliverySeq))).toBeGreaterThan(run1Final);
    // live subscriber saw both runs (thread channel, incl. the later run).
    expect(live.some((e) => e.runId === R1)).toBe(true);
    expect(live.some((e) => e.runId === R2)).toBe(true);

    // reconnect after run1's final cursor -> exactly run2's events, none of run1's.
    const replay = await loadCanonicalThread(THREAD, run1Final);
    const run2Ids = new Set(run2.map((e) => e.eventId));
    for (const e of run2) expect(replay.some((r) => r.eventId === e.eventId && r.runId === R2)).toBe(true);
    expect(replay.every((r) => r.deliverySeq > run1Final)).toBe(true);
    expect(replay.every((r) => run2Ids.has(r.eventId))).toBe(true); // no earlier-turn leakage
  });
});
