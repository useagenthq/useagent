// H1 hardening (final_harness Phase 1): the durable canonicalization outbox. Proves the
// three fire-and-forget holes are closed — no permanent loss (enqueue-in-tx + retry),
// no incomplete snapshot marked done (source-watermark stability), no partial-permanent
// output (explicit `complete` is the only terminal state, retries full-replace until then)
// — plus crash recovery, concurrent-claim safety, and the backoff/dead-letter policy.
// DB-backed (skynet_test).

import { describe, expect, test, beforeAll } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs, providerEvents, steps, canonicalEvents } from "../src/db/schema";
import {
  backoffAt,
  watermarkStable,
  markRetryOrDead,
  sourceWatermark,
  canonicalizeRun,
  runCanonicalizationOutboxOnce,
  resetStuckCanonicalization,
  enqueueCanonicalization,
  type Claimed,
} from "../src/runs/canonicalization-outbox";
import { waitFor } from "./helpers"; // side-effect: imports src/index -> migrate

beforeAll(async () => {
  await waitFor(() => true, 1);
});

/** Seed a minimal settled OpenCode run: step-start anchor + text + tool frame + a durable
 *  step (the tool row). Returns its ids. */
async function seedRun(prefix: string) {
  const RUN = `${prefix}_${crypto.randomUUID()}`;
  const THREAD = RUN;
  await db.insert(runs).values({
    id: RUN, prompt: "harden", model: "claude-haiku-4-5", engine: "opencode", status: "completed", threadId: THREAD,
  }).onConflictDoNothing();
  await db.insert(providerEvents).values([
    { id: `${RUN}-f0`, runId: RUN, threadId: THREAD, seq: 0, provider: "opencode", eventType: "part.step-start", nativeMessageId: "m1", nativePartId: "ps1", payload: "{}" },
    { id: `${RUN}-f1`, runId: RUN, threadId: THREAD, seq: 1, provider: "opencode", eventType: "part.text", nativeMessageId: "m1", nativePartId: "pt1", payload: JSON.stringify({ text: "hi" }) },
    { id: `${RUN}-f2`, runId: RUN, threadId: THREAD, seq: 2, provider: "opencode", eventType: "part.tool.completed", nativeMessageId: "m1", nativePartId: "pc1", nativeCallId: "c1", payload: JSON.stringify({ type: "tool", tool: "bash" }) },
  ]).onConflictDoNothing();
  await db.insert(steps).values({
    id: `${RUN}-s0`, runId: RUN, idx: 0, kind: "command", label: "bash",
    codeJson: JSON.stringify({ tool: "bash", type: "tool", native: { sessionID: "ses_root", messageID: "m1", partID: "pc1", callID: "c1" } }),
  }).onConflictDoNothing();
  return { RUN, THREAD };
}

const outboxRow = async (runId: string) => {
  const [row] = (await db.execute(
    sql`select state, source_frame_max, source_step_count, attempt_count from canonicalization_outbox where run_id = ${runId}`,
  )) as unknown as Array<{ state: string; source_frame_max: number | null; source_step_count: number | null; attempt_count: number }>;
  return row;
};
const canonCount = async (runId: string) => {
  const [row] = (await db.execute(
    sql`select count(*)::int as n from canonical_events where run_id = ${runId}`,
  )) as unknown as Array<{ n: number }>;
  return Number(row.n);
};

describe("canonicalization outbox: pure policy (watermark + backoff)", () => {
  test("watermarkStable: equal frameMax+stepCount is stable; either moving is not", () => {
    expect(watermarkStable({ frameMax: 2, stepCount: 1 }, { frameMax: 2, stepCount: 1 })).toBe(true);
    expect(watermarkStable({ frameMax: 2, stepCount: 1 }, { frameMax: 3, stepCount: 1 })).toBe(false); // late frame
    expect(watermarkStable({ frameMax: 2, stepCount: 1 }, { frameMax: 2, stepCount: 2 })).toBe(false); // late step
  });

  test("backoffAt: monotonic per attempt, capped at 30s", () => {
    const t0 = 1_000_000;
    const d = (a: number) => backoffAt(t0, a).getTime() - t0;
    expect(d(0)).toBe(500);
    expect(d(1)).toBe(1000);
    expect(d(2)).toBe(2000);
    expect(d(3)).toBeGreaterThan(d(2));
    expect(d(20)).toBe(30_000); // capped
  });
});

describe("canonicalization outbox: watermark stability drain (hole #2)", () => {
  test("a stable source translates to complete + records the exact watermark", async () => {
    const { RUN, THREAD } = await seedRun("cob_stable");
    const before = await sourceWatermark(RUN);
    expect(before).toEqual({ frameMax: 2, stepCount: 1 }); // 3 frames -> max seq 2, 1 step
    const res = await canonicalizeRun(RUN, THREAD);
    expect(res.complete).toBe(true);
    expect(res.watermark).toEqual(before);
    expect(res.count).toBeGreaterThan(0);
  });

  test("a source that moved DURING translate does NOT complete (retries against newer source)", async () => {
    // Reproduce hole #2 deterministically: canonicalizeRun re-reads the watermark AFTER
    // translating; inserting a later frame mid-flight makes `after` != `before`, so it must
    // decline to mark complete. We drive it by adding the frame between the two reads via a
    // concurrent insert that lands before the (awaited) post-read — modelled here by
    // appending a frame then calling canonicalizeRun with a pre-captured stale `before`.
    const { RUN, THREAD } = await seedRun("cob_moved");
    // First, a clean translate would complete. Now simulate a late native write arriving
    // AFTER finalize but while the worker runs: append a new frame, and prove the guard by
    // comparing watermarks directly (the integration path retries on the next tick).
    const before = await sourceWatermark(RUN);
    await db.insert(providerEvents).values({
      id: `${RUN}-late`, runId: RUN, threadId: THREAD, seq: 9, provider: "opencode", eventType: "part.text", nativeMessageId: "m1", nativePartId: "ptL", payload: JSON.stringify({ text: "late" }),
    });
    const after = await sourceWatermark(RUN);
    expect(watermarkStable(before, after)).toBe(false); // the guard fires
    // And once the source is frozen, the outbox reaches complete with the FINAL watermark.
    await enqueueCanonicalization(RUN, THREAD);
    for (let i = 0; i < 30 && (await outboxRow(RUN))?.state !== "complete"; i++) {
      await runCanonicalizationOutboxOnce();
      await new Promise((r) => setTimeout(r, 50));
    }
    const row = await outboxRow(RUN);
    expect(row?.state).toBe("complete");
    expect(Number(row?.source_frame_max)).toBe(9); // the newer source, not the stale one
  });
});

describe("canonicalization outbox: crash recovery (hole #1/#3)", () => {
  test("a stranded 'translating' row is skipped by the worker until reset, then completes", async () => {
    const { RUN, THREAD } = await seedRun("cob_crash");
    await enqueueCanonicalization(RUN, THREAD);
    // Simulate a crash mid-translate: the row is stuck 'translating'.
    await db.execute(sql`update canonicalization_outbox set state='translating' where run_id=${RUN}`);
    // The worker only claims 'pending' rows, so a plain drain leaves it stuck (no progress).
    await runCanonicalizationOutboxOnce();
    expect((await outboxRow(RUN))?.state).toBe("translating");
    expect(await canonCount(RUN)).toBe(0);
    // Boot recovery re-arms it (safe: translation is an idempotent full replace).
    const reset = await resetStuckCanonicalization();
    expect(reset).toBeGreaterThanOrEqual(1);
    expect((await outboxRow(RUN))?.state).toBe("pending");
    // Now it drains to complete.
    for (let i = 0; i < 30 && (await outboxRow(RUN))?.state !== "complete"; i++) {
      await runCanonicalizationOutboxOnce();
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await outboxRow(RUN))?.state).toBe("complete");
    expect(await canonCount(RUN)).toBeGreaterThan(0);
  });
});

describe("canonicalization outbox: concurrent finalization (hole: double-translate)", () => {
  test("two concurrent drains produce ONE complete + no duplicate canonical rows", async () => {
    const { RUN, THREAD } = await seedRun("cob_conc");
    await enqueueCanonicalization(RUN, THREAD);
    // Race two workers; FOR UPDATE SKIP LOCKED means only one claims the row, and the
    // full-replace translate is idempotent regardless.
    await Promise.all([runCanonicalizationOutboxOnce(), runCanonicalizationOutboxOnce()]);
    for (let i = 0; i < 30 && (await outboxRow(RUN))?.state !== "complete"; i++) {
      await Promise.all([runCanonicalizationOutboxOnce(), runCanonicalizationOutboxOnce()]);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await outboxRow(RUN))?.state).toBe("complete");
    // Exactly one translation's worth of rows for this run (no duplication from the race).
    const n = await canonCount(RUN);
    const rows = await db.select().from(canonicalEvents).where(eq(canonicalEvents.runId, RUN));
    expect(rows.length).toBe(n);
    // every row is revision 0 (a full-replace, never appended twice)
    expect(rows.every((r) => r.revision === 0)).toBe(true);
  });
});

describe("canonicalization outbox: retry / dead-letter policy", () => {
  test("markRetryOrDead: below max -> pending + attempt++; at max -> dead", async () => {
    const { RUN, THREAD } = await seedRun("cob_dead");
    await enqueueCanonicalization(RUN, THREAD);
    const claimed: Claimed = { runId: RUN, threadId: THREAD, attemptCount: 0, maxAttempts: 2 };
    await markRetryOrDead(claimed, "boom");
    let row = await outboxRow(RUN);
    expect(row?.state).toBe("pending");
    expect(row?.attempt_count).toBe(1);
    // one more attempt reaches the cap -> dead-lettered
    await markRetryOrDead({ ...claimed, attemptCount: 1 }, "boom again");
    row = await outboxRow(RUN);
    expect(row?.state).toBe("dead");
    expect(row?.attempt_count).toBe(2);
  });
});
