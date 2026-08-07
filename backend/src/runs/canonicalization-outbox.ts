/**
 * Durable canonicalization outbox (final_harness Phase 1 hardening).
 *
 * Fixes the fire-and-forget holes:
 *  - #1 permanent loss: finalizeRun enqueues the intent INSIDE the finalization
 *    transaction, so a crash never leaves a settled run with no canonical history.
 *  - #2 incomplete snapshot: a worker reads the source (frames + steps), translates,
 *    and RE-READS the source watermark; it marks `complete` ONLY when the watermark is
 *    stable across the translate, so a late native write can't leave a partial result
 *    marked done.
 *  - #3 partial-permanent: `complete` (with the watermark) is the explicit completion
 *    record; retries continue until then, replacing provisional output each attempt.
 * Multi-instance safe (claim via FOR UPDATE SKIP LOCKED); crash-recovered (stuck
 * `translating` rows reset to `pending` at boot - safe because translation is an
 * idempotent full replace while still provisional).
 */
import { eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { canonicalizationOutbox } from "../db/schema";
import { getNativeFramesSince } from "./native-events";
import { getStepsApi } from "./repo";
import { translateOpenCode, type OpenCodeFrame, type OpenCodeStep } from "../engines/opencode-canonical";
import { publishDelivered, replaceCanonicalForRun } from "./canonical-events";

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
export const backoffAt = (now: number, attempt: number): Date =>
  new Date(now + Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS));

export interface Watermark { frameMax: number; stepCount: number }
/** The source is STABLE across a translate iff neither the max native-frame seq nor the
 *  step count moved. A settled run's source is frozen, so instability only reflects the
 *  narrow write-race between finalize and the worker claiming the row - retry, don't
 *  mark a partial snapshot complete (hole #2). Pure, so the gate is unit-testable. */
export const watermarkStable = (a: Watermark, b: Watermark): boolean =>
  a.frameMax === b.frameMax && a.stepCount === b.stepCount;

/** Enqueue a run's canonicalization. Idempotent by runId. Enqueue INSIDE the run-
 *  finalization transaction so the intent commits atomically with the terminal run;
 *  a re-finalization of a NOT-yet-complete run re-arms it (a `complete` row is left
 *  untouched). */
export async function enqueueCanonicalization(runId: string, threadId: string, exec: Executor = db): Promise<void> {
  await exec
    .insert(canonicalizationOutbox)
    .values({ runId, threadId })
    .onConflictDoUpdate({
      target: canonicalizationOutbox.runId,
      set: {
        // never regress a completed canonicalization; otherwise re-arm for a retry.
        state: sql`case when ${canonicalizationOutbox.state} = 'complete' then 'complete' else 'pending' end`,
        nextAttemptAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    });
}

/** The source watermark (max native-frame seq + step count) - proves what was translated. */
export async function sourceWatermark(runId: string): Promise<Watermark> {
  const [w] = (await db.execute(sql`
    select coalesce((select max(seq) from provider_events where run_id = ${runId}), -1) as frame_max,
           (select count(*) from steps where run_id = ${runId}) as step_count`)) as unknown as Array<{ frame_max: number; step_count: number }>;
  // the single-row aggregate always returns a row; guard only to satisfy strict null checks.
  return { frameMax: Number(w?.frame_max ?? -1), stepCount: Number(w?.step_count ?? 0) };
}

export interface Claimed { runId: string; threadId: string; attemptCount: number; maxAttempts: number }

async function claimDue(limit: number): Promise<Claimed[]> {
  const rows = (await db.execute(sql`
    with due as (
      select run_id from canonicalization_outbox
      where state = 'pending' and next_attempt_at <= now()
      order by next_attempt_at asc limit ${limit}
      for update skip locked
    )
    update canonicalization_outbox o set state = 'translating', updated_at = now()
    from due where o.run_id = due.run_id
    returning o.run_id, o.thread_id, o.attempt_count, o.max_attempts`)) as unknown as Array<{
    run_id: string; thread_id: string; attempt_count: number; max_attempts: number;
  }>;
  return rows.map((r) => ({ runId: r.run_id, threadId: r.thread_id, attemptCount: Number(r.attempt_count), maxAttempts: Number(r.max_attempts) }));
}

export async function markComplete(runId: string, w: Watermark): Promise<void> {
  await db
    .update(canonicalizationOutbox)
    .set({ state: "complete", sourceFrameMax: w.frameMax, sourceStepCount: w.stepCount, lastError: null, updatedAt: new Date() })
    .where(eq(canonicalizationOutbox.runId, runId));
}
export async function markRetryOrDead(c: Claimed, err: string): Promise<void> {
  const dead = c.attemptCount + 1 >= c.maxAttempts;
  await db
    .update(canonicalizationOutbox)
    .set({
      state: dead ? "dead" : "pending",
      attemptCount: sql`${canonicalizationOutbox.attemptCount} + 1`,
      nextAttemptAt: backoffAt(Date.now(), c.attemptCount + 1),
      lastError: err.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(canonicalizationOutbox.runId, c.runId));
}

/** Translate ONE run's source, but commit only if the source was STABLE across the
 *  translate (watermark unchanged) - so a late native write is retried, not lost.
 *  Returns whether it completed (and the watermark it locked in). */
export async function canonicalizeRun(runId: string, threadId: string): Promise<{ complete: boolean; count: number; watermark: Watermark }> {
  const before = await sourceWatermark(runId);
  const [frames, steps] = await Promise.all([getNativeFramesSince(runId, -1), getStepsApi(runId)]);
  const { events } = translateOpenCode(
    frames as unknown as OpenCodeFrame[],
    { runId, threadId },
    steps as unknown as OpenCodeStep[],
  );
  const after = await sourceWatermark(runId);
  if (!watermarkStable(before, after)) {
    return { complete: false, count: 0, watermark: after }; // source moved - retry against the newer source
  }
  const delivered = await replaceCanonicalForRun(runId, events);
  publishDelivered(delivered); // persist-before-publish: rows are committed above
  return { complete: true, count: delivered.length, watermark: before };
}

/** Process up to `limit` due canonicalizations. Returns how many completed. */
export async function runCanonicalizationOutboxOnce(limit = 20): Promise<number> {
  const claimed = await claimDue(limit);
  let done = 0;
  for (const c of claimed) {
    try {
      const res = await canonicalizeRun(c.runId, c.threadId);
      if (res.complete) { await markComplete(c.runId, res.watermark); done++; }
      else await markRetryOrDead(c, "source watermark moved during translate");
    } catch (e) {
      await markRetryOrDead(c, e instanceof Error ? e.message : String(e));
    }
  }
  return done;
}

/** Boot recovery: a crash mid-translate leaves a `translating` row stranded. Reset it
 *  to `pending` - SAFE because canonicalization is an idempotent full replace while
 *  provisional (unlike memory delivery, which could double-send). */
export async function resetStuckCanonicalization(): Promise<number> {
  const rows = (await db.execute(sql`update canonicalization_outbox set state='pending', updated_at=now()
    where state='translating' returning run_id`)) as unknown as unknown[];
  return rows.length;
}

/** Background loop (mounted at boot). Config-free; a no-op when nothing is due. */
export function startCanonicalizationOutbox(intervalMs = 1000): () => void {
  const tick = () => void runCanonicalizationOutboxOnce().catch((e) => console.error("[canonical-outbox] tick:", e));
  const t = setInterval(tick, intervalMs);
  t.unref?.();
  return () => clearInterval(t);
}
