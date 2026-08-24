import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Memory capture outbox (memory Phase 3b). Durable, retryable write-back of a
// run's outcome to team memory — replaces the old fire-and-forget POST that was
// lost on any failure. Mirrors slack_outbox's shape (a SEPARATE table by design;
// no shared outbox framework this cycle — convergence noted in the progress log).
//
// Memory-specific difference: AT-MOST-once delivery. /v3/conversation/add has no
// idempotency key, so a re-delivery would create a DUPLICATE L0 turn. A row
// orphaned in `delivering` by a crash is therefore left for MANUAL inspection —
// never auto-reset to pending — trading a rare lost capture for never
// duplicating a team-memory turn.
// ---------------------------------------------------------------------------

export type MemoryOutboxState = "pending" | "delivering" | "delivered" | "dead";

export const memoryOutbox = pgTable(
  "memory_outbox",
  {
    /** = runId — one capture per run, so enqueue is naturally idempotent. */
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    /** Bounded JSON: { identity, prompt, summary }. */
    payload: text("payload").notNull(),
    state: text("state").$type<MemoryOutboxState>().notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    /** Earliest a pending row may be (re)delivered — exponential backoff. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The delivery worker claims due rows by (state, next_attempt_at).
    index("idx_memory_outbox_due").on(t.state, t.nextAttemptAt),
  ],
);
