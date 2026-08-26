import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { runs } from "./runs";

/**
 * Canonical agent-event lane. Provider-neutral events the
 * backend translates every harness INTO (see @useagent/agent-harness/canonical). Persisted
 * BEFORE publishing to the browser SSE so replay + live use the SAME rows. Runs
 * ALONGSIDE provider_events (the bounded raw sidecar) - additive, not a replacement.
 *
 * TWO distinct cursors, deliberately separated:
 *  - `deliverySeq` (bigserial PK) is the IMMUTABLE, append-only, THREAD-wide delivery
 *    cursor. It only ever increases; a later run in a thread always gets higher
 *    values than every earlier turn; a browser resumes with "everything after N".
 *  - `seq` is the per-run/source ordering (the translator's dense intra-run cursor)
 *    used to reconstruct a single run's order - never a delivery cursor.
 * Revisions are APPEND-ONLY: a re-emitted `eventId` inserts a NEW row (higher
 * `revision`, higher `deliverySeq`) - it never mutates/reorders an already-delivered
 * cursor. Downstream keeps the latest revision per `eventId`.
 */
export const canonicalEvents = pgTable(
  "canonical_events",
  {
    deliverySeq: bigserial("delivery_seq", { mode: "number" }).primaryKey(),
    eventId: text("event_id").notNull(), // stable per (run, native event); NOT unique - revisions append
    revision: integer("revision").notNull().default(0),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    threadId: text("thread_id").notNull(),
    seq: integer("seq").notNull(), // per-run/source ordering (NOT a delivery cursor)
    turnId: text("turn_id"),
    kind: text("kind").notNull(),
    ts: bigint("ts", { mode: "number" }).notNull(), // useAgent-assigned ms epoch
    identity: jsonb("identity").$type<Record<string, unknown>>().notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_canonical_events_thread_delivery").on(t.threadId, t.deliverySeq),
    index("idx_canonical_events_run").on(t.runId, t.seq),
    index("idx_canonical_events_event").on(t.eventId),
  ],
);

export type CanonicalizationState = "pending" | "translating" | "complete" | "dead";

/**
 * Durable canonicalization outbox. One row per run,
 * enqueued INSIDE the run-finalization transaction so the intent to canonicalize
 * commits ATOMICALLY with the run reaching a terminal state - a crash never leaves a
 * settled run with no canonical history. A worker claims due rows (FOR UPDATE SKIP
 * LOCKED, multi-instance-safe), translates the source (frames + steps), and marks
 * `complete` ONLY when the SOURCE WATERMARK is stable across the translate (so a late
 * fire-and-forget native write can't leave a partial translation marked done). The
 * `complete` row + watermark is the authoritative "canonicalization done" record -
 * React trusts canonical only when it exists.
 */
export const canonicalizationOutbox = pgTable(
  "canonicalization_outbox",
  {
    runId: text("run_id").primaryKey().references(() => runs.id),
    threadId: text("thread_id").notNull(),
    state: text("state").$type<CanonicalizationState>().notNull().default("pending"),
    /** Watermark of the source that was translated to reach `complete`. */
    sourceFrameMax: integer("source_frame_max"),
    sourceStepCount: integer("source_step_count"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_canon_outbox_due").on(t.state, t.nextAttemptAt)],
);
