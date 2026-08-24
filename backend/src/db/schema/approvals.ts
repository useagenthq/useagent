import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { runs } from "./runs";

// ---------------------------------------------------------------------------
// Human-in-the-loop approval lane (#77). A run's agent records a durable
// approval REQUEST for one approval-gated gateway operation; an org member
// approves or denies it via /api/gateway/approvals. Approving mints the
// one-shot operation capability (gateway_operation_approvals stays the
// cryptographic single-use ledger) and parks it on the row until the agent
// polls it out - `capability` is nulled on handout so it is delivered exactly
// once. State transitions are single-shot (guarded by `status = 'pending'`).
// ---------------------------------------------------------------------------

export const APPROVAL_REQUEST_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

export const gatewayApprovalRequests = pgTable(
  "gateway_approval_requests",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    toolName: text("tool_name").notNull(),
    arguments: jsonb("arguments").$type<Record<string, unknown>>().notNull(),
    /** Canonical hash of `arguments` (approvalArgumentsHash) - the exact
     *  operation the human approves and the minted capability binds to. */
    argumentsHash: text("arguments_hash").notNull(),
    status: text("status").$type<ApprovalRequestStatus>().notNull().default("pending"),
    /** The minted one-shot capability, present only between approval and the
     *  agent's poll. Never returned by the human-facing API. */
    capability: text("capability"),
    capabilityExpiresAt: timestamp("capability_expires_at", { withTimezone: true }),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
  },
  (t) => [
    index("idx_gateway_approval_requests_run").on(t.runId, t.status),
    index("idx_gateway_approval_requests_thread").on(t.threadId, t.status),
  ],
);
