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
// timer; landing is idempotent, so a retry can never double count. An announcement that
// fails after its correction committed is tracked on its own and retried the same way.
//
// The memory copy is process-local (single-replica scope, like the drain barrier) and
// only bridges the gap until the durable rows land. A process restart before an
// unflushed loss reaches the table loses the marker; the frame is lost either way and
// the run can then seal clean. That residual is documented here rather than hidden;
// closing it needs a durable per-run capture-open marker, a separate change.
// ---------------------------------------------------------------------------

/** Delay before an unflushed loss or an unsent announcement is retried. */
const DEFAULT_RETRY_MS = 5_000;
let retryMs = DEFAULT_RETRY_MS;

/** Namespace of the per-run advisory lock, in the two-key lock space, so it never
 *  collides with the single-key thread locks the command lane takes (a root run's
 *  thread id is its run id). */
const CAPTURE_LOSS_LOCK_NAMESPACE = 0x4c_4f_53_53;

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
/** Runs whose degraded seal still has to be announced (the correction committed, the
 *  announcement did not go out yet). Independent of the pending ledger rows. */
const pendingAnnouncements = new Set<string>();
const announceRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

export interface CaptureLoss {
  readonly lostFrames: number;
  readonly lastError: string | null;
}

/** The per-run advisory lock the ledger flush and the seal transaction both take, so
 *  their reads and writes serialize. Transaction-scoped: released at commit or rollback. */
export function captureLossLock(runId: string): SQL {
  return sql`select pg_advisory_xact_lock(${CAPTURE_LOSS_LOCK_NAMESPACE}::int, hashtext(${runId}))`;
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
 *  the idempotent insert makes that retry harmless. Once the rows are down, the degraded
 *  seal is announced; with nothing pending, a call only retries an unsent announcement. */
export function flushCaptureLoss(runId: string): Promise<void> {
  const entry = captureLosses.get(runId);
  if (!entry || entry.pending.size === 0) {
    return pendingAnnouncements.has(runId) ? announceDegradedSeal(runId) : Promise.resolve();
  }
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
      if (consumeSimulatedFailure(lostAcknowledgementsForTest, runId)) throw new Error("simulated lost acknowledgement");
      for (const f of batch) entry.pending.delete(f.eventId);
    }
    captureLosses.delete(runId);
    pendingAnnouncements.add(runId);
    await announceDegradedSeal(runId);
  })()
    .catch((err) => {
      if (entry.pending.size > 0) {
        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = null;
          void flushCaptureLoss(runId).catch(() => {});
        }, retryMs);
        entry.retryTimer.unref?.();
      }
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
 *  connection and drops repeats; the client store never clears a degraded mark. A run
 *  not sealed yet needs nothing (canonicalizeRun reads the ledger inside its transaction
 *  and publishes the seal it writes). A failure keeps the announcement pending and
 *  retries it on the timer. */
function announceDegradedSeal(runId: string): Promise<void> {
  const timer = announceRetryTimers.get(runId);
  if (timer) {
    clearTimeout(timer);
    announceRetryTimers.delete(runId);
  }
  return (async () => {
    if (consumeSimulatedFailure(announcementFailuresForTest, runId)) throw new Error("simulated announcement failure");
    const [row] = (await db.execute(sql`
      select thread_id, source_frame_max, source_step_count from canonicalization_outbox
      where run_id = ${runId} and state = 'complete_degraded'`)) as unknown as Array<{
      thread_id: string; source_frame_max: number | null; source_step_count: number | null;
    }>;
    if (row) {
      const rows = (await db.execute(sql`
        select count(*)::int as n from run_capture_loss where run_id = ${runId}`)) as unknown as Array<{ n: number | string }>;
      publishCanonicalizationComplete({
        runId,
        threadId: row.thread_id,
        sourceFrameMax: Number(row.source_frame_max ?? -1),
        sourceStepCount: Number(row.source_step_count ?? 0),
        degraded: true,
        lostFrames: Math.max(1, Number(rows[0]?.n ?? 0)),
      });
    }
    pendingAnnouncements.delete(runId);
  })().catch((err) => {
    const retry = setTimeout(() => {
      announceRetryTimers.delete(runId);
      void announceDegradedSeal(runId).catch(() => {});
    }, retryMs);
    retry.unref?.();
    announceRetryTimers.set(runId, retry);
    throw err;
  });
}

// ── Test hooks ───────────────────────────────────────────────────────────────

const lostAcknowledgementsForTest = new Map<string, number>();
const announcementFailuresForTest = new Map<string, number>();

function consumeSimulatedFailure(map: Map<string, number>, runId: string): boolean {
  const left = map.get(runId) ?? 0;
  if (left <= 0) return false;
  if (left === 1) map.delete(runId);
  else map.set(runId, left - 1);
  return true;
}

/** Tests only: make the run's next `times` flushes behave as if their transaction
 *  committed but the acknowledgement was lost, so the frames stay pending and the retry
 *  must be idempotent. */
export function simulateLostFlushAcknowledgementForTest(runId: string, times = 1): void {
  lostAcknowledgementsForTest.set(runId, times);
}

/** Tests only: make the run's next `times` announcements fail after their correction
 *  committed, so the announcement must be retried on its own. */
export function simulateAnnouncementFailureForTest(runId: string, times = 1): void {
  announcementFailuresForTest.set(runId, times);
}

/** Tests only: shorten the retry timer. */
export function setCaptureLossRetryDelayForTest(ms: number): void {
  retryMs = ms;
}

/** Tests only: lost frames still pending in memory for the run. */
export function pendingCaptureLossForTest(runId: string): number {
  return captureLosses.get(runId)?.pending.size ?? 0;
}

/** Tests only: forget the in-memory ledger, as a process restart would. */
export function resetCaptureLossMemoryForTest(): void {
  for (const entry of captureLosses.values()) {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
  }
  for (const timer of announceRetryTimers.values()) clearTimeout(timer);
  captureLosses.clear();
  pendingAnnouncements.clear();
  announceRetryTimers.clear();
  lostAcknowledgementsForTest.clear();
  announcementFailuresForTest.clear();
  retryMs = DEFAULT_RETRY_MS;
}
