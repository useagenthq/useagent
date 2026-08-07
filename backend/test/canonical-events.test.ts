// Phase 1 slice-3 gate: durable canonical-event persistence with the PERSIST-BEFORE-
// PUBLISH invariant. A canonical event must be written to canonical_events BEFORE it
// is emitted to live subscribers, so replay (loadCanonicalThread) and live serve the
// SAME rows. Also proves idempotent upsert (a revision keeps latest seq) + ordered
// replay. DB-backed against the isolated skynet_test DB.

import { describe, expect, test, beforeAll } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import {
  loadCanonicalThread,
  persistAndPublish,
  persistCanonicalEvents,
  subscribeCanonical,
} from "../src/runs/canonical-events";
import { translateOpenCode, type OpenCodeFrame } from "../src/engines/opencode-canonical";
import { waitFor } from "./helpers"; // side-effect: imports src/index -> migrate

const RUN = `cet_${crypto.randomUUID()}`;
const THREAD = RUN;

beforeAll(async () => {
  await waitFor(() => true, 1); // ensure migrate() ran
  await db.insert(runs).values({
    id: RUN,
    prompt: "canonical-events test",
    model: "claude-haiku-4-5",
    engine: "opencode",
    status: "completed",
    threadId: THREAD,
  }).onConflictDoNothing();
});

function sampleEvents() {
  const frames: OpenCodeFrame[] = [
    { eventId: "f1", seq: 0, provider: "opencode", eventType: "part.text",
      native: { sessionId: "ses_a", parentSessionId: null, messageId: "m1", partId: "p1", callId: null }, payload: { text: "hi" } },
    { eventId: "f2", seq: 1, provider: "opencode", eventType: "part.tool.completed",
      native: { sessionId: "ses_a", parentSessionId: null, messageId: "m1", partId: "p2", callId: "call_x" }, payload: { type: "tool", tool: "bash" } },
  ];
  return translateOpenCode(frames, { runId: RUN, threadId: THREAD }).events;
}

describe("canonical-events durable store (skynet_test)", () => {
  test("PERSIST-BEFORE-PUBLISH: the row exists in the DB when a subscriber is notified", async () => {
    const events = sampleEvents();
    let persistedWhenNotified: boolean | null = null;
    const unsub = subscribeCanonical(RUN, async (e) => {
      if (persistedWhenNotified !== null) return; // first event only
      const rows = (await db.execute(sql`select 1 from canonical_events where event_id = ${e.eventId}`)) as unknown[];
      persistedWhenNotified = rows.length > 0;
    });
    await persistAndPublish(events);
    await waitFor(() => persistedWhenNotified !== null, 2000);
    unsub();
    expect(persistedWhenNotified).toBe(true);
  });

  test("ordered replay returns every persisted event by seq", async () => {
    const events = sampleEvents();
    const back = await loadCanonicalThread(THREAD, -1);
    expect(back.length).toBeGreaterThanOrEqual(events.length);
    expect(back.map((e) => e.seq)).toEqual([...back.map((e) => e.seq)].sort((a, b) => a - b));
    // round-trips the discriminated body (kind + fields survive jsonb).
    const text = back.find((e) => e.kind === "message.delta");
    expect(text && (text as { text: string }).text).toBe("hi");
  });

  test("idempotent upsert: re-persisting the same eventId keeps ONE row (latest seq)", async () => {
    const events = sampleEvents();
    const before = (await loadCanonicalThread(THREAD)).length;
    // Re-persist the same eventIds with a bumped seq (a revision).
    await persistCanonicalEvents(events.map((e) => ({ ...e, seq: e.seq + 1000 })));
    const after = await loadCanonicalThread(THREAD);
    expect(after.length).toBe(before); // no duplicates - upsert on eventId
    const bumped = after.find((e) => e.eventId === events[0].eventId);
    expect(bumped?.seq).toBe(events[0].seq + 1000); // latest seq won
  });
});
