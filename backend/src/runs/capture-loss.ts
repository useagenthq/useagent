import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { errorMessage } from "../util/error-message";
import { publishCanonicalizationComplete } from "./canonical-events";

// ---------------------------------------------------------------------------
// Capture-loss ledger. A provider frame whose capture write still fails after the
// bounded retry in provider-events.ts is a LOST frame: the run's native history is
// missing something the provider emitted. Each loss is recorded by (run, event id):
// in memory at once, and durably in run_capture_loss by an idempotent insert that is
// retried until it lands. The canonicalization outbox reads the ledger at seal time and
// seals such a run `complete_degraded`, never `complete`. A loss that arrives AFTER a
// clean seal (a post-finalize producer such as follow-up suggestions) corrects the seal
// monotonically: `complete` becomes `complete_degraded` and the completion signal is
// published again, so no reader is left trusting a completeness that no longer holds.
//
// The memory copy is process-local (single-replica scope, like the drain barrier) and
// only bridges the gap until the durable rows land. A process restart during a database
// outage, before an unflushed loss reaches the table, loses the marker; the frame is
// lost either way and the run can then seal clean. That residual is documented here
// rather than hidden.
// ---------------------------------------------------------------------------

/** Delay before an unflushed loss is retried after a failed ledger write. */
const FLUSH_RETRY_MS = 5_000;

interface LostFrame {
  readonly eventId: string;
  readonly eventType: string;
  readonly error: string;
}

interface CaptureLossEntry {
  readonly threadId: string;
  /** Lost frames not yet known to be durable, keyed by event id. */
  readonly pending: Map<string, LostFrame>;
  flushing: Promise<void> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const captureLosses = new Map<string, CaptureLossEntry>();

export interface CaptureLoss {
  readonly lostFrames: number;
  readonly lastError: string | null;
}

/** Record one lost frame for a run and start landing it durably. */
export function noteCaptureLoss(
  input: { runId: string; threadId: string; id: string; eventType: string },
  error: string,
): void {
  let entry = captureLosses.get(input.runId);
  if (!entry) {
    entry = { threadId: input.threadId, pending: new Map(), flushing: null, retryTimer: null };
    captureLosses.set(input.runId, entry);
  }
  entry.pending.set(input.id, { eventId: input.id, eventType: input.eventType, error });
  console.error(
    `[provider-events] LOST frame ${input.id} for run ${input.runId} (${input.eventType}); the run seals as complete_degraded:`,
    error,
  );
  void flushCaptureLoss(input.runId).catch(() => {});
}

/** Land every pending loss for a run: one insert per lost event id, `on conflict do
 *  nothing`, so a retry after an ambiguous commit can never double count. Loops until
 *  nothing is pending, so a loss noted during a flush is carried by the same call. One
 *  flush in flight per run. On failure the pending set is kept and retried later.
 *  After the rows land, a seal that already completed is corrected to degraded. */
export function flushCaptureLoss(runId: string): Promise<void> {
  const entry = captureLosses.get(runId);
  if (!entry || entry.pending.size === 0) return Promise.resolve();
  if (entry.flushing) return entry.flushing;
  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }
  const flush = (async () => {
    while (entry.pending.size > 0) {
      const batch = [...entry.pending.values()];
      await db.execute(sql`
        insert into run_capture_loss (run_id, event_id, thread_id, event_type, error)
        select ${runId}, e.event_id, ${entry.threadId}, e.event_type, e.error
        from json_to_recordset(${JSON.stringify(batch.map((f) => ({
          event_id: f.eventId, event_type: f.eventType, error: f.error.slice(0, 500),
        })))}::json) as e(event_id text, event_type text, error text)
        on conflict (run_id, event_id) do nothing`);
      for (const f of batch) entry.pending.delete(f.eventId);
    }
    captureLosses.delete(runId);
    await degradeSealedCanonicalization(runId);
  })()
    .catch((err) => {
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        void flushCaptureLoss(runId).catch(() => {});
      }, FLUSH_RETRY_MS);
      entry.retryTimer.unref?.();
      throw err;
    })
    .finally(() => {
      entry.flushing = null;
    });
  entry.flushing = flush;
  return flush;
}

/** The run's capture loss as the seal sees it: the durable rows plus anything still only
 *  in memory, after one more attempt to land it. Null when nothing was lost. */
export async function captureLossForRun(runId: string): Promise<CaptureLoss | null> {
  await flushCaptureLoss(runId).catch(() => {});
  const [row] = (await db.execute(sql`
    select count(*)::int as n, (array_agg(error order by at desc))[1] as last_error
    from run_capture_loss where run_id = ${runId}`)) as unknown as Array<{ n: number | string; last_error: string | null }>;
  const durable = Number(row?.n ?? 0);
  const pending = captureLosses.get(runId)?.pending;
  const lostFrames = durable + (pending?.size ?? 0);
  if (lostFrames === 0) return null;
  const lastPending = pending && pending.size > 0 ? [...pending.values()].at(-1)!.error : null;
  return { lostFrames, lastError: lastPending ?? row?.last_error ?? null };
}

/** Monotonic seal correction for a loss recorded after a clean seal: flip `complete` to
 *  `complete_degraded` and publish the completion again with the loss count. A seal that
 *  is still pending needs nothing (canonicalizeRun reads the ledger); a degraded seal is
 *  already right. */
async function degradeSealedCanonicalization(runId: string): Promise<void> {
  const rows = (await db.execute(sql`
    update canonicalization_outbox
    set state = 'complete_degraded', updated_at = now()
    where run_id = ${runId} and state = 'complete'
    returning thread_id, source_frame_max, source_step_count`)) as unknown as Array<{
    thread_id: string; source_frame_max: number | null; source_step_count: number | null;
  }>;
  const row = rows[0];
  if (!row) return;
  const loss = await captureLossForRun(runId);
  publishCanonicalizationComplete({
    runId,
    threadId: row.thread_id,
    sourceFrameMax: Number(row.source_frame_max ?? -1),
    sourceStepCount: Number(row.source_step_count ?? 0),
    degraded: true,
    lostFrames: loss?.lostFrames ?? 1,
  });
  console.warn(`[canonical-outbox] run ${runId} sealed complete before a capture loss arrived; corrected to complete_degraded`);
}

/** Tests only: forget the in-memory ledger, as a process restart would. */
export function resetCaptureLossMemoryForTest(): void {
  for (const entry of captureLosses.values()) {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
  }
  captureLosses.clear();
}

export const captureLossInternals = { errorMessage };
