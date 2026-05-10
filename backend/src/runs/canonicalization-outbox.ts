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
import { getRun, getStepsApi } from "./repo";
import { drainProviderEvents } from "./provider-events";
import { translateOpenCode, type OpenCodeFrame, type OpenCodeStep } from "../engines/opencode-canonical";
import type { CanonicalAgentEvent } from "../engines/canonical";
import { canonicalEngine } from "../engines/engine-alias";
import {
  publishDelivered,
  publishCanonicalizationComplete,
  replaceCanonicalRowsTx,
  type DeliveredCanonicalEvent,
} from "./canonical-events";

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
export const backoffAt = (now: number, attempt: number): Date =>
  new Date(now + Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS));

export interface Watermark { frameMax: number; stepCount: number; stepSig: string }
/** The source is STABLE across a translate iff the max native-frame seq AND the step
 *  CONTENT SIGNATURE both held. The signature (a hash over every step's id/idx/kind/
 *  code_json) detects an IN-PLACE step update (tool_call -> tool_result rewrites code_json
 *  with the SAME step count), which a bare count(*) misses - the exact hole where a run
 *  could be marked complete showing a tool_call without its result. A settled run's source
 *  is frozen, so instability only reflects the narrow write-race between finalize and the
 *  worker - retry, don't freeze a partial snapshot (hole #2). Pure, so unit-testable. */
export const watermarkStable = (a: Watermark, b: Watermark): boolean =>
  a.frameMax === b.frameMax && a.stepSig === b.stepSig;

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

/** The source watermark: max native-frame seq + step count + a step CONTENT signature.
 *  The signature is `md5` over each step's id|idx|kind|code_json (ordered), so an in-place
 *  code_json rewrite changes it even when the count does not. `md5`/`string_agg` are
 *  built-in Postgres - no dependency. */
export async function sourceWatermark(runId: string): Promise<Watermark> {
  const [w] = (await db.execute(sql`
    select coalesce((select max(seq) from provider_events where run_id = ${runId}), -1) as frame_max,
           (select count(*) from steps where run_id = ${runId}) as step_count,
           coalesce((
             select md5(string_agg(id || '\x1f' || idx::text || '\x1f' || kind || '\x1f' || coalesce(code_json, ''),
                                    '\n' order by idx, id))
             from steps where run_id = ${runId}
           ), '') as step_sig`)) as unknown as Array<{ frame_max: number; step_count: number; step_sig: string }>;
  // the single-row aggregate always returns a row; guard only to satisfy strict null checks.
  return { frameMax: Number(w?.frame_max ?? -1), stepCount: Number(w?.step_count ?? 0), stepSig: String(w?.step_sig ?? "") };
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

/** ATOMIC finalize: write the run's FINAL canonical rows AND flip its outbox record to
 *  `complete` (with the watermark) in ONE transaction. Because rows are written only here
 *  - never provisionally - canonical_events holds rows only for a COMPLETE run, so a crash
 *  or a watermark-retry can never leave stale provisional rows a client could trust. The
 *  publish happens AFTER this commits (see the worker), so subscribers only ever receive
 *  finalized rows. Returns the delivered rows to publish. */
async function finalizeCanonicalForRun(
  runId: string, events: readonly CanonicalAgentEvent[], w: Watermark,
): Promise<DeliveredCanonicalEvent[]> {
  return db.transaction(async (tx) => {
    const delivered = await replaceCanonicalRowsTx(tx, runId, events);
    await tx
      .update(canonicalizationOutbox)
      .set({ state: "complete", sourceFrameMax: w.frameMax, sourceStepCount: w.stepCount, lastError: null, updatedAt: new Date() })
      .where(eq(canonicalizationOutbox.runId, runId));
    return delivered;
  });
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

/** Translate ONE run's source and, only if the source held STABLE across the translate,
 *  ATOMICALLY write the final rows + completion record. Steps carry the run's engine as
 *  provenance. Never publishes here (the worker publishes after the tx commits). Returns
 *  the finalized rows + watermark, or complete:false to retry against the newer source. */
export async function canonicalizeRun(runId: string, threadId: string): Promise<{ complete: boolean; delivered: DeliveredCanonicalEvent[]; watermark: Watermark }> {
  // Seal in-flight provider-event writes BEFORE the first watermark read, so a queued
  // capture can't commit after both reads and be missed (drain barrier).
  await drainProviderEvents(runId);
  const before = await sourceWatermark(runId);
  const [run, frames, steps] = await Promise.all([getRun(runId), getNativeFramesSince(runId, -1), getStepsApi(runId)]);
  const { events } = translateOpenCode(
    frames as unknown as OpenCodeFrame[],
    // Honest step provenance, with legacy aliases normalized (daytona -> opencode,
    // claude-sdk -> claude) so an alias run renders IDENTICALLY to its base provider.
    { runId, threadId, engine: canonicalEngine(run?.engine ?? "opencode") },
    steps as unknown as OpenCodeStep[],
  );
  const after = await sourceWatermark(runId);
  if (!watermarkStable(before, after)) {
    return { complete: false, delivered: [], watermark: after }; // source moved - retry against the newer source
  }
  const delivered = await finalizeCanonicalForRun(runId, events, before);
  return { complete: true, delivered, watermark: before };
}

/** Process up to `limit` due canonicalizations. Returns how many completed. */
export async function runCanonicalizationOutboxOnce(limit = 20): Promise<number> {
  const claimed = await claimDue(limit);
  let done = 0;
  for (const c of claimed) {
    try {
      const res = await canonicalizeRun(c.runId, c.threadId);
      if (res.complete) {
        // PERSIST-BEFORE-PUBLISH: the rows + completion committed atomically above, so
        // publishing now only ever emits FINALIZED rows (never provisional). A reconnect
        // replays the same committed rows, so live + replay converge; the publish is
        // idempotent (the store keeps the latest revision per eventId).
        publishDelivered(res.delivered);
        publishCanonicalizationComplete({
          runId: c.runId, threadId: c.threadId,
          sourceFrameMax: res.watermark.frameMax, sourceStepCount: res.watermark.stepCount,
        });
        done++;
      } else await markRetryOrDead(c, "source watermark moved during translate");
    } catch (e) {
      await markRetryOrDead(c, e instanceof Error ? e.message : String(e));
    }
  }
  return done;
}

/** The runs in a THREAD whose canonicalization has reached `complete` (H2 replay source).
 *  A reconnecting thread stream loads these so React knows which runs to trust the
 *  canonical lane for, independent of provisional rows still in flight. */
export async function completeCanonicalRuns(threadId: string): Promise<Array<{ runId: string; sourceFrameMax: number; sourceStepCount: number }>> {
  const rows = (await db.execute(sql`
    select run_id, source_frame_max, source_step_count from canonicalization_outbox
    where thread_id = ${threadId} and state = 'complete'`)) as unknown as Array<{
    run_id: string; source_frame_max: number | null; source_step_count: number | null;
  }>;
  return rows.map((r) => ({ runId: r.run_id, sourceFrameMax: Number(r.source_frame_max ?? -1), sourceStepCount: Number(r.source_step_count ?? 0) }));
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
