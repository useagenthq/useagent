import { asc, eq, lte, sql } from "drizzle-orm";
import { db } from "../db/client";
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

/** Claim due parked rows (next_attempt_at <= now), oldest first, up to `limit`.
 *  Single-replica scope: the loop is single-flight, so no row-locking is needed. */
export async function claimDueReconciles(limit = 20): Promise<ReconcileEntry[]> {
  const rows = await db
    .select()
    .from(reconcileQueue)
    .where(lte(reconcileQueue.nextAttemptAt, sql`now()`))
    .orderBy(asc(reconcileQueue.nextAttemptAt))
    .limit(limit);
  return rows.map((r) => ({
    runId: r.runId,
    threadId: r.threadId,
    sandboxId: r.sandboxId,
    sessionId: r.sessionId,
    sinceMs: r.sinceAt.getTime(),
    attempts: r.attempts,
    deadlineMs: r.deadline.getTime(),
  }));
}

/** Schedule the next re-probe (attempts += 1, next_attempt_at = backoff). */
export async function bumpReconcile(runId: string, nextAttemptAt: Date): Promise<void> {
  await db
    .update(reconcileQueue)
    .set({ attempts: sql`${reconcileQueue.attempts} + 1`, nextAttemptAt })
    .where(eq(reconcileQueue.runId, runId));
}

/** Remove a parked row once its run has settled (adopted / failed / stolen). */
export async function deleteReconcile(runId: string): Promise<void> {
  await db.delete(reconcileQueue).where(eq(reconcileQueue.runId, runId));
}

/** Ops/test read helper. */
export async function getReconcile(runId: string) {
  const [row] = await db.select().from(reconcileQueue).where(eq(reconcileQueue.runId, runId)).limit(1);
  return row ?? null;
}
