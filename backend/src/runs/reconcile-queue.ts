import { and, eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { reconcileQueue } from "../db/schema";

// ---------------------------------------------------------------------------
// Durable parked state for the adaptive post-boot reconciler (#63). A run whose
// one-shot boot probe was TRANSIENT (still in_progress / unreachable) is parked
// here instead of honest-failed; a background loop (src/runs/recovery.ts) re-
// probes it on a short backoff within a bounded budget. This module owns ONLY the
// table + the pure timing policy — it imports nothing from finalize/reconcile, so
// the loop can live in recovery.ts without an import cycle.
// ---------------------------------------------------------------------------

/** Total park budget: after this the run is honest-failed with the resumable
 *  summary. ~21% of crash-storm kills reconcile within a few minutes, so 5m
 *  covers the tail without holding a genuinely-dead run open too long. */
export const RECONCILE_PARK_BUDGET_MS = 300_000;

/** Re-probe backoff: 15s, 30s, then 60s (capped). Short enough to adopt a run
 *  that finishes seconds after a restart, long enough not to hammer the sandbox. */
const RECONCILE_BACKOFFS_MS = [15_000, 30_000, 60_000] as const;

/** Next re-probe time for a row that just made its `attempts`-th attempt. Pure. */
export function reconcileBackoffAt(nowMs: number, attempts: number): Date {
  const i = Math.min(Math.max(attempts, 0), RECONCILE_BACKOFFS_MS.length - 1);
  return new Date(nowMs + RECONCILE_BACKOFFS_MS[i]!);
}

/** The action for a re-probe outcome. Pure (the policy), unit-tested without a DB:
 *  a completed session is ADOPTED; otherwise RETRY until the deadline, then FAIL. */
export function nextReconcileAction(
  completed: boolean,
  nowMs: number,
  deadlineMs: number,
): "adopt" | "fail" | "retry" {
  if (completed) return "adopt";
  return nowMs >= deadlineMs ? "fail" : "retry";
}

export interface ReconcileEntry {
  readonly runId: string;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly sinceMs: number;
  readonly attempts: number;
  readonly deadlineMs: number;
  /** The lease this claim holds: the exact next_attempt_at the claim wrote. Every row write
   *  the tick makes is fenced on it, so a tick that outlived its lease and was replaced
   *  cannot reschedule, inflate or delete the row its replacement now owns. */
  readonly leaseUntil: Date;
}

/**
 * Park a run for background reconciliation, AT MOST once per run (run_id pk +
 * onConflictDoNothing). Idempotent so the reconciler's own restart — which re-
 * runs boot recovery — preserves the ORIGINAL deadline (a crash loop can't extend
 * the budget forever). Returns true when a NEW row was parked.
 */
export async function enqueueReconcile(input: {
  runId: string;
  threadId: string;
  sandboxId: string;
  sessionId: string;
  sinceAt: Date;
  nextAttemptAt: Date;
  deadline: Date;
}): Promise<boolean> {
  const inserted = await db
    .insert(reconcileQueue)
    .values({
      runId: input.runId,
      threadId: input.threadId,
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      sinceAt: input.sinceAt,
      nextAttemptAt: input.nextAttemptAt,
      deadline: input.deadline,
    })
    .onConflictDoNothing({ target: reconcileQueue.runId })
    .returning({ runId: reconcileQueue.runId });
  return inserted.length > 0;
}

/** How long a claimed row stays invisible to other claims while its tick probes it: the
 *  probe race budget (11 s) plus finalize headroom. A tick that dies mid-flight simply lets
 *  the lease expire, so a crash never strands a parked run; the lease is not an attempt. */
export const RECONCILE_CLAIM_LEASE_MS = 60_000;

/** Claim due parked rows (next_attempt_at <= now), oldest first, up to `limit`, and LEASE
 *  them: the same statement pushes next_attempt_at to the lease, so an overlapping tick
 *  (the watchdog can resurrect one) cannot claim a row that is already being probed. The
 *  select locks its rows with SKIP LOCKED, so two claims running at once split the due set
 *  instead of sharing it. Due is checked against the DB clock, like the outbox primitive;
 *  the lease timestamp is minted here at millisecond precision so it doubles as the fence
 *  token every later write for the row is compared against. */
export async function claimDueReconciles(
  limit = 20,
  leaseMs = RECONCILE_CLAIM_LEASE_MS,
): Promise<ReconcileEntry[]> {
  const leaseUntil = new Date(Date.now() + leaseMs);
  const rows = (await db.execute(sql`
    with due as (
      select run_id, next_attempt_at as due_at from reconcile_queue
      where next_attempt_at <= now()
      order by next_attempt_at asc
      limit ${limit}
      for update skip locked
    )
    update reconcile_queue q
    set next_attempt_at = ${leaseUntil.toISOString()}::timestamptz
    from due where q.run_id = due.run_id
    returning q.run_id, q.thread_id, q.sandbox_id, q.session_id, q.since_at, q.attempts, q.deadline, due.due_at`)) as unknown as Array<{
    run_id: string; thread_id: string; sandbox_id: string; session_id: string;
    since_at: string | Date; attempts: number | string; deadline: string | Date; due_at: string | Date;
  }>;
  return rows
    .toSorted((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime())
    .map((r) => ({
      runId: r.run_id,
      threadId: r.thread_id,
      sandboxId: r.sandbox_id,
      sessionId: r.session_id,
      sinceMs: new Date(r.since_at).getTime(),
      attempts: Number(r.attempts),
      deadlineMs: new Date(r.deadline).getTime(),
      leaseUntil,
    }));
}

/** The row filter for a fenced write: the run, and (when a lease is given) only while the
 *  row still carries exactly that lease. A tick whose lease expired and whose row was
 *  re-claimed then matches nothing, so it cannot touch its replacement's work. */
const claimedRow = (runId: string, lease?: Date) =>
  lease ? and(eq(reconcileQueue.runId, runId), eq(reconcileQueue.nextAttemptAt, lease)) : eq(reconcileQueue.runId, runId);

/** Schedule the next re-probe (attempts += 1, next_attempt_at = backoff), fenced on the
 *  claim's lease when given. Returns whether the row was written. */
export async function bumpReconcile(runId: string, nextAttemptAt: Date, lease?: Date): Promise<boolean> {
  const rows = await db
    .update(reconcileQueue)
    .set({ attempts: sql`${reconcileQueue.attempts} + 1`, nextAttemptAt })
    .where(claimedRow(runId, lease))
    .returning({ runId: reconcileQueue.runId });
  return rows.length > 0;
}

/** Remove a parked row once its run has settled (adopted / failed / stolen), fenced on the
 *  claim's lease when given. Runs on `exec` so the reconciler can make it the ownership
 *  guard INSIDE its finalization transaction. Returns whether the row was removed. */
export async function deleteReconcile(runId: string, lease?: Date, exec: Executor = db): Promise<boolean> {
  const rows = await exec
    .delete(reconcileQueue)
    .where(claimedRow(runId, lease))
    .returning({ runId: reconcileQueue.runId });
  return rows.length > 0;
}

/** Whether the row still carries exactly this claim's lease: the cheap ownership check a
 *  tick makes before writing anything that is not itself fenced (recovered events). */
export async function reconcileClaimHeld(runId: string, lease: Date): Promise<boolean> {
  const [row] = await db
    .select({ runId: reconcileQueue.runId })
    .from(reconcileQueue)
    .where(claimedRow(runId, lease))
    .limit(1);
  return !!row;
}

/** Ops/test read helper. */
export async function getReconcile(runId: string) {
  const [row] = await db.select().from(reconcileQueue).where(eq(reconcileQueue.runId, runId)).limit(1);
  return row ?? null;
}
