import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { runs } from "./runs";

// ---------------------------------------------------------------------------
// Durable commands — every external/product mutation enters through one (north
// star "Durable Commands"). Stage-1 scope: the `run.create` command behind
// POST /api/runs. `idempotency_key` is UNIQUE PER ORG (partial index, keyed rows
// only) so a lost HTTP response retried with the same key observes the ORIGINAL
// command instead of starting duplicate work. `payload_fingerprint` detects a
// key reused for a DIFFERENT request (ambiguous → 409, never silently rerun).
// ---------------------------------------------------------------------------

export type CommandState = "queued" | "dispatched" | "completed" | "failed";

export const commands = pgTable(
  "commands",
  {
    id: text("id").primaryKey(),
    // Client-supplied idempotency key. Null for the no-key path (still a durable
    // command row, just not deduplicated). Scoped to `org_id` for uniqueness.
    idempotencyKey: text("idempotency_key"),
    orgId: text("org_id"),
    actorId: text("actor_id"),
    kind: text("kind").notNull(), // Stage 1: "run.create"
    // The run this command produced (its target resource). Same-tx FK-safe: the
    // run row is inserted first inside the acceptance transaction.
    runId: text("run_id").references(() => runs.id),
    threadId: text("thread_id"),
    // Stable hash of the accepted request's semantic fields — a replay with a
    // matching fingerprint is idempotent; a mismatch under the same key is a
    // conflict. Bounded `payload` is retained for audit.
    payloadFingerprint: text("payload_fingerprint"),
    payload: text("payload"),
    state: text("state").$type<CommandState>().notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Per-tenant idempotency: only keyed rows participate, so the no-key path
    // (null key) never collides. `org_id` is always server-resolved (non-null)
    // at the command boundary, so (org, key) uniquely identifies a retry.
    uniqueIndex("uq_commands_idem")
      .on(t.orgId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index("idx_commands_run").on(t.runId),
    // The durable per-thread mailbox: the dispatcher finds a thread's in-flight
    // (state='dispatched') and its oldest queued command by (thread_id, state,
    // created_at). Ordered so the head-of-queue lookup is index-only.
    index("idx_commands_thread_state").on(t.threadId, t.state, t.createdAt),
  ],
);
