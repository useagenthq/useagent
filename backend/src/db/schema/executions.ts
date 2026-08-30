import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { runs } from "./runs";
import { providerEvents } from "./provider-events";

export const EXECUTION_MODES = ["root", "native_child"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const EXECUTION_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const DELEGATION_KINDS = [
  "spawn",
  "wait",
  "send",
  "resume",
  "close",
  "gather",
] as const;
export type DelegationKind = (typeof DELEGATION_KINDS)[number];

export const EXECUTION_GRAPH_OBSERVATION_KINDS = ["spawn", "control", "lifecycle"] as const;
export type ExecutionGraphObservationKind = (typeof EXECUTION_GRAPH_OBSERVATION_KINDS)[number];

export const EXECUTION_GRAPH_RESOLUTION_REASONS = [
  "applied",
  "source_irrelevant",
  "edge_only",
  "superseded",
] as const;
export type ExecutionGraphResolutionReason = (typeof EXECUTION_GRAPH_RESOLUTION_REASONS)[number];

/**
 * One provider-neutral harness execution. `run_id` remains the owning user turn;
 * `runs.parent_run_id` keeps its existing sequential-conversation meaning.
 * `source_key` is the adapter's immutable, replay-stable identity.
 */
export const agentExecutions = pgTable(
  "agent_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    mode: text("mode").$type<ExecutionMode>().notNull(),
    provider: text("provider").notNull(),
    nativeSessionId: text("native_session_id"),
    nativeParentSessionId: text("native_parent_session_id"),
    status: text("status").$type<ExecutionStatus>().notNull().default("queued"),
    attempt: integer("attempt").notNull().default(1),
    lastEventId: text("last_event_id"),
    lastEventRevision: bigint("last_event_revision", { mode: "number" }).notNull().default(0),
    lastDeliverySeq: bigint("last_delivery_seq", { mode: "number" }).notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("agent_executions_mode_check", sql`${t.mode} IN ('root', 'native_child')`),
    check(
      "agent_executions_status_check",
      sql`${t.status} IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')`,
    ),
    check("agent_executions_attempt_check", sql`${t.attempt} >= 1`),
    check(
      "agent_executions_watermark_check",
      sql`${t.lastEventRevision} >= 0 AND ${t.lastDeliverySeq} >= 0`,
    ),
    check("agent_executions_source_key_check", sql`length(${t.sourceKey}) > 0`),
    check(
      "agent_executions_native_child_session_check",
      sql`${t.mode} <> 'native_child' OR ${t.nativeSessionId} IS NOT NULL`,
    ),
    uniqueIndex("uq_agent_executions_scope_id").on(t.orgId, t.runId, t.id),
    uniqueIndex("uq_agent_executions_source").on(t.orgId, t.runId, t.sourceKey),
    uniqueIndex("uq_agent_executions_root")
      .on(t.orgId, t.runId)
      .where(sql`${t.mode} = 'root'`),
    uniqueIndex("uq_agent_executions_native_session")
      .on(t.orgId, t.runId, t.provider, t.nativeSessionId)
      .where(sql`${t.nativeSessionId} IS NOT NULL`),
    index("idx_agent_executions_graph").on(t.orgId, t.runId, t.createdAt, t.id),
    index("idx_agent_executions_native_session").on(t.provider, t.nativeSessionId),
  ],
);

/**
 * A durable delegation/control observation. Only `spawn` is allowed to create a
 * child execution; every other kind can reference one but is edge-only.
 */
export const delegationEdges = pgTable(
  "delegation_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    parentExecutionId: uuid("parent_execution_id").notNull(),
    childExecutionId: uuid("child_execution_id"),
    kind: text("kind").$type<DelegationKind>().notNull(),
    provider: text("provider").notNull(),
    providerCallId: text("provider_call_id"),
    nativeEventId: text("native_event_id"),
    nativeTargetSessionId: text("native_target_session_id"),
    observedDeliverySeq: bigint("observed_delivery_seq", { mode: "number" }).notNull().default(0),
    /** Database-monotonic insertion cursor. Provider delivery seq can be shared
     * by multiple target edges from one event, so it is not a safe page key. */
    cursorSeq: bigserial("cursor_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "delegation_edges_kind_check",
      sql`${t.kind} IN ('spawn', 'wait', 'send', 'resume', 'close', 'gather')`,
    ),
    check("delegation_edges_spawn_child_check", sql`${t.kind} <> 'spawn' OR ${t.childExecutionId} IS NOT NULL`),
    check("delegation_edges_source_key_check", sql`length(${t.sourceKey}) > 0`),
    check(
      "delegation_edges_provider_identity_check",
      sql`(${t.providerCallId} IS NOT NULL AND length(${t.providerCallId}) > 0) OR (${t.nativeEventId} IS NOT NULL AND length(${t.nativeEventId}) > 0)`,
    ),
    check("delegation_edges_delivery_seq_check", sql`${t.observedDeliverySeq} >= 0`),
    foreignKey({
      name: "fk_delegation_edges_parent_execution",
      columns: [t.orgId, t.runId, t.parentExecutionId],
      foreignColumns: [agentExecutions.orgId, agentExecutions.runId, agentExecutions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_delegation_edges_child_execution",
      columns: [t.orgId, t.runId, t.childExecutionId],
      foreignColumns: [agentExecutions.orgId, agentExecutions.runId, agentExecutions.id],
    }).onDelete("cascade"),
    uniqueIndex("uq_delegation_edges_source").on(t.orgId, t.runId, t.sourceKey),
    index("idx_delegation_edges_graph").on(t.orgId, t.runId, t.observedDeliverySeq, t.id),
    index("idx_delegation_edges_cursor").on(t.orgId, t.runId, t.cursorSeq),
    index("idx_delegation_edges_parent").on(
      t.orgId, t.runId, t.parentExecutionId, t.observedDeliverySeq, t.id,
    ),
    index("idx_delegation_edges_child").on(
      t.orgId, t.runId, t.childExecutionId, t.observedDeliverySeq, t.id,
    ),
  ],
);

/** Pointer-only recovery state for graph observations whose required execution
 * identity arrived out of order. Provider events remain the payload truth. */
export const executionGraphPendingObservations = pgTable(
  "execution_graph_pending_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id")
      .notNull()
      .references(() => providerEvents.id, { onDelete: "cascade" }),
    latestObservationKind: text("latest_observation_kind").$type<ExecutionGraphObservationKind>(),
    latestNativeParentSessionId: text("latest_native_parent_session_id"),
    latestNativeChildSessionId: text("latest_native_child_session_id"),
    latestRelevant: boolean("latest_relevant").notNull().default(true),
    latestExecutionRequired: boolean("latest_execution_required").notNull().default(true),
    latestStructureHash: text("latest_structure_hash").notNull(),
    firstDeferredDeliverySeq: bigint("first_deferred_delivery_seq", { mode: "number" }).notNull(),
    latestProviderEventSeq: bigint("latest_provider_event_seq", { mode: "number" }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    exhaustedAt: timestamp("exhausted_at", { withTimezone: true }),
    exhaustionCode: text("exhaustion_code"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionReason: text("resolution_reason").$type<ExecutionGraphResolutionReason>(),
    appliedStructureHash: text("applied_structure_hash"),
    structuralMismatchAt: timestamp("structural_mismatch_at", { withTimezone: true }),
    structuralMismatchSourceSeq: bigint("structural_mismatch_source_seq", { mode: "number" }),
    structuralMismatchCode: text("structural_mismatch_code"),
  },
  (t) => [
    check(
      "execution_graph_pending_kind_check",
      sql`${t.latestObservationKind} IS NULL OR ${t.latestObservationKind} IN ('spawn', 'control', 'lifecycle')`,
    ),
    check(
      "execution_graph_pending_resolution_check",
      sql`${t.resolutionReason} IS NULL OR ${t.resolutionReason} IN ('applied', 'source_irrelevant', 'edge_only', 'superseded')`,
    ),
    check(
      "execution_graph_pending_sequence_check",
      sql`${t.firstDeferredDeliverySeq} >= 0 AND ${t.latestProviderEventSeq} >= 0 AND ${t.attemptCount} >= 0`,
    ),
    check(
      "execution_graph_pending_resolved_pair_check",
      sql`(${t.resolvedAt} IS NULL) = (${t.resolutionReason} IS NULL)`,
    ),
    check(
      "execution_graph_pending_mismatch_pair_check",
      sql`(${t.structuralMismatchAt} IS NULL AND ${t.structuralMismatchSourceSeq} IS NULL AND ${t.structuralMismatchCode} IS NULL) OR (${t.structuralMismatchAt} IS NOT NULL AND ${t.structuralMismatchSourceSeq} IS NOT NULL AND ${t.structuralMismatchCode} IS NOT NULL)`,
    ),
    check(
      "execution_graph_pending_exhaustion_pair_check",
      sql`(${t.exhaustedAt} IS NULL) = (${t.exhaustionCode} IS NULL)`,
    ),
    uniqueIndex("uq_execution_graph_pending_source").on(
      t.orgId,
      t.runId,
      t.provider,
      t.providerEventId,
    ),
    index("idx_execution_graph_pending_parent").on(
      t.orgId,
      t.runId,
      t.provider,
      t.latestNativeParentSessionId,
      t.resolvedAt,
      t.firstDeferredDeliverySeq,
    ),
    index("idx_execution_graph_pending_child").on(
      t.orgId,
      t.runId,
      t.provider,
      t.latestNativeChildSessionId,
      t.resolvedAt,
      t.firstDeferredDeliverySeq,
    ),
  ],
);

export type AgentExecutionRow = typeof agentExecutions.$inferSelect;
export type DelegationEdgeRow = typeof delegationEdges.$inferSelect;
export type ExecutionGraphPendingObservationRow = typeof executionGraphPendingObservations.$inferSelect;
