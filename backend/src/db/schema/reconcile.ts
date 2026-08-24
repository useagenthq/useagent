import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Reconcile queue (#63 adaptive post-boot reconciler). The one-shot boot probe
// honest-FAILS a run whose native session in fact completes moments after a fast
// restart (~21% of crash-storm kills). Instead, boot PARKS such a run here and a
// background loop re-probes it on a short backoff within a bounded budget: adopt
// the finished session on success, honest-fail only after the deadline. This row
// IS the durable "reconciling" marker — the run stays `running` and the parked
// state survives the reconciler's OWN restart because it lives in the DB, not
// memory. One row per parked run (run_id pk ⇒ re-park is idempotent, so a
// crash-looping backend preserves the original deadline).
// ---------------------------------------------------------------------------

export const reconcileQueue = pgTable(
  "reconcile_queue",
  {
    /** The parked run (still `running`). PK ⇒ enqueue is idempotent per run. */
    runId: text("run_id").primaryKey(),
    threadId: text("thread_id").notNull(),
    /** Native handle for the re-probe (opencode session in its Daytona sandbox). */
    sandboxId: text("sandbox_id").notNull(),
    sessionId: text("session_id").notNull(),
    /** Our last-activity watermark — a completed assistant message must be strictly
     *  newer than this to count as THIS turn's result (reconcile `sinceMs`). */
    sinceAt: timestamp("since_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Earliest the next re-probe may run (backoff 15s/30s/60s). */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** Park budget end — after this, honest-fail with the resumable summary. */
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The reconcile loop claims due rows by next_attempt_at.
    index("idx_reconcile_due").on(t.nextAttemptAt),
  ],
);
