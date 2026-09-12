import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import { publishCanonicalizationComplete } from "./canonical-events";

// ---------------------------------------------------------------------------
// Capture-loss ledger. A provider frame whose capture write still fails after the
// bounded retry in provider-events.ts is a LOST frame: the run's native history is
// missing something the provider emitted. Each loss is recorded by (run, event id):
// in memory at once, and durably in run_capture_loss by an idempotent insert that is
// retried until it lands. The canonicalization outbox reads the ledger INSIDE its seal
// transaction and seals such a run `complete_degraded`, never `complete`.
//
// Ledger and seal serialize on one advisory lock per run (captureLossLock), so a loss
// either lands before the seal reads the ledger, or lands after the seal committed and
// then corrects it: `complete` becomes `complete_degraded` in the same transaction as
// the ledger rows, and the completion is announced again after commit. A flush that
// fails, or whose acknowledgement is lost, keeps its frames pending and is retried on a
// timer; landing is idempotent, so a retry can never double count.
//
// The memory copy is process-local (single-replica scope, like the drain barrier) and
// only bridges the gap until the durable rows land. A process restart before an
// unflushed loss reaches the table loses the marker; the frame is lost either way and
// the run can then seal clean. That residual is documented here rather than hidden;
// closing it needs a durable per-run capture-open marker, a separate change.
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

/** The per-run advisory lock the ledger flush and the seal transaction both take, so
 *  their reads and writes serialize. Transaction-scoped: released at commit or rollback. */
export function captureLossLock(runId: string): SQL {
  return sql`select pg_advisory_xact_lock(hashtext(${runId}))`;
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

/** Land every pending loss for a run and correct an already-clean seal, in one
 *  transaction per batch under the run's advisory lock. Loops until nothing is pending,
 *  so a loss noted during a flush is carried by the same call; one flush in flight per
 *  run. A frame leaves the pending set only after its transaction is known to have
 *  committed, so a failure or a lost acknowledgement keeps it for the timed retry, and
 *  the idempotent insert makes that retry harmless. After a batch lands, a degraded seal
 *  is announced (again, if need be: the announcement is idempotent for readers). */
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
      await db.transaction(async (tx) => {
        await tx.execute(captureLossLock(runId));
        await tx.execute(sql`
          insert into run_capture_loss (run_id, event_id, thread_id, event_type, error)
          select ${runId}, e.event_id, ${entry.threadId}, e.event_type, e.error
          from json_to_recordset(${JSON.stringify(batch.map((f) => ({
            event_id: f.eventId, event_type: f.eventType, error: f.error.slice(0, 500),
          })))}::json) as e(event_id text, event_type text, error text)
          on conflict (run_id, event_id) do nothing`);
        await tx.execute(sql`
          update canonicalization_outbox set state = 'complete_degraded', updated_at = now()
          where run_id = ${runId} and state = 'complete'`);
      });
      if (lostAcknowledgementForTest.delete(runId)) throw new Error("simulated lost acknowledgement");
      for (const f of batch) entry.pending.delete(f.eventId);
    }
    captureLosses.delete(runId);
    await announceDegradedSeal(runId);
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

/** Lost frames known for the run: the union of the durable rows and what is still only
 *  pending in memory (a frame can be in both after a lost acknowledgement; it counts once). */
export async function captureLossForRun(runId: string): Promise<CaptureLoss | null> {
  await flushCaptureLoss(runId).catch(() => {});
  const rows = (await db.execute(sql`
    select event_id, error from run_capture_loss where run_id = ${runId} order by at desc`)) as unknown as Array<{
    event_id: string; error: string | null;
  }>;
  const ids = new Set(rows.map((r) => r.event_id));
  const pending = captureLosses.get(runId)?.pending;
  for (const id of pending?.keys() ?? []) ids.add(id);
  if (ids.size === 0) return null;
  const lastPending = pending && pending.size > 0 ? [...pending.values()].at(-1)!.error : null;
  return { lostFrames: ids.size, lastError: lastPending ?? rows[0]?.error ?? null };
}

/** Publish the completion for a run whose seal is degraded, with the current loss count.
 *  Idempotent for readers: the thread stream admits one clean-to-degraded correction per
 *  connection and drops repeats; the client store never clears a degraded mark. */
async function announceDegradedSeal(runId: string): Promise<void> {
  const [row] = (await db.execute(sql`
    select thread_id, source_frame_max, source_step_count from canonicalization_outbox
    where run_id = ${runId} and state = 'complete_degraded'`)) as unknown as Array<{
    thread_id: string; source_frame_max: number | null; source_step_count: number | null;
  }>;
  if (!row) return; // not sealed yet: canonicalizeRun reads the ledger inside its transaction
  const loss = await captureLossForRun(runId);
  publishCanonicalizationComplete({
    runId,
    threadId: row.thread_id,
    sourceFrameMax: Number(row.source_frame_max ?? -1),
    sourceStepCount: Number(row.source_step_count ?? 0),
    degraded: true,
    lostFrames: loss?.lostFrames ?? 1,
  });
}

const lostAcknowledgementForTest = new Set<string>();

/** Tests only: make the run's next flush behave as if its transaction committed but the
 *  acknowledgement was lost, so the frames stay pending and the retry must be idempotent. */
export function simulateLostFlushAcknowledgementForTest(runId: string): void {
  lostAcknowledgementForTest.add(runId);
}

/** Tests only: forget the in-memory ledger, as a process restart would. */
export function resetCaptureLossMemoryForTest(): void {
  for (const entry of captureLosses.values()) {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
  }
  captureLosses.clear();
}
