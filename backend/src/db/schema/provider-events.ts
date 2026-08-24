import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { runs } from "./runs";

// ---------------------------------------------------------------------------
// Provider events — lossless native capture (ARCHITECTURE north star, Phase 1).
// One row per native part (upserted to its latest revision) plus session
// lifecycle rows. Bounded payload; the `steps` table stays the compatibility
// projection on top of this.
// ---------------------------------------------------------------------------

export const providerEvents = pgTable(
  "provider_events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    threadId: text("thread_id").notNull(),
    seq: integer("seq").notNull(),
    provider: text("provider").notNull(),
    eventType: text("event_type").notNull(),
    nativeSessionId: text("native_session_id"),
    nativeParentSessionId: text("native_parent_session_id"),
    nativeMessageId: text("native_message_id"),
    nativePartId: text("native_part_id"),
    nativeCallId: text("native_call_id"),
    payload: text("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_provider_events_run").on(t.runId, t.seq),
    index("idx_provider_events_part").on(t.nativePartId),
    index("idx_provider_events_type_run").on(t.eventType, t.runId),
  ],
);

// Trusted provider-gateway request receipts. This is deliberately separate from
// provider_events: the gateway is a second process and must not participate in
// the agent lane's process-local sequence allocator. Bodies, headers, and keys
// are never stored—only authorization/spend metadata.
export const providerGatewayAudit = pgTable(
  "provider_gateway_audit",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    orgId: text("org_id").notNull(),
    provider: text("provider").notNull(),
    path: text("path").notNull(),
    model: text("model").notNull(),
    requestedOutputTokens: integer("requested_output_tokens").notNull().default(0),
    outcome: text("outcome")
      .$type<"started" | "responded" | "failed">()
      .notNull(),
    upstreamStatus: integer("upstream_status"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("idx_provider_gateway_audit_run").on(t.runId, t.createdAt)],
);
