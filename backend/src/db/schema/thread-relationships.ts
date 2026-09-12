import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentExecutions } from "./executions";
import { runs } from "./runs";

export const THREAD_RELATIONSHIP_KINDS = [
  "root",
  "delegated",
  "continued_from_native",
] as const;
export type ThreadRelationshipKind = (typeof THREAD_RELATIONSHIP_KINDS)[number];

export const threadRelationships = pgTable(
  "thread_relationships",
  {
    orgId: text("org_id").notNull(),
    threadId: text("thread_id").notNull(),
    parentThreadId: text("parent_thread_id"),
    familyThreadId: text("family_thread_id").notNull(),
    kind: text("kind").$type<ThreadRelationshipKind>().notNull(),
    title: text("title").notNull(),
    sourceRunId: text("source_run_id").notNull(),
    sourceExecutionId: uuid("source_execution_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "thread_relationships_org_thread_pk", columns: [t.orgId, t.threadId] }),
    check("thread_relationships_kind_check", sql`${t.kind} IN ('root', 'delegated', 'continued_from_native')`),
    check("thread_relationships_title_check", sql`length(${t.title}) BETWEEN 1 AND 160`),
    check(
      "thread_relationships_shape_check",
      sql`(
        ${t.kind} = 'root'
        AND ${t.parentThreadId} IS NULL
        AND ${t.familyThreadId} = ${t.threadId}
        AND ${t.sourceRunId} = ${t.threadId}
        AND ${t.sourceExecutionId} IS NULL
      ) OR (
        ${t.kind} = 'delegated'
        AND ${t.parentThreadId} IS NOT NULL
        AND ${t.familyThreadId} <> ${t.threadId}
        AND ${t.sourceExecutionId} IS NULL
      ) OR (
        ${t.kind} = 'continued_from_native'
        AND ${t.parentThreadId} IS NOT NULL
        AND ${t.familyThreadId} <> ${t.threadId}
        AND ${t.sourceExecutionId} IS NOT NULL
      )`,
    ),
    foreignKey({
      name: "fk_thread_relationships_root_run",
      columns: [t.orgId, t.threadId],
      foreignColumns: [runs.orgId, runs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_thread_relationships_parent",
      columns: [t.orgId, t.parentThreadId],
      foreignColumns: [t.orgId, t.threadId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_thread_relationships_family",
      columns: [t.orgId, t.familyThreadId],
      foreignColumns: [t.orgId, t.threadId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_thread_relationships_source_run",
      columns: [t.orgId, t.sourceRunId],
      foreignColumns: [runs.orgId, runs.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_thread_relationships_source_execution",
      columns: [t.orgId, t.sourceRunId, t.sourceExecutionId],
      foreignColumns: [agentExecutions.orgId, agentExecutions.runId, agentExecutions.id],
    }).onDelete("restrict"),
    index("idx_thread_relationships_family").on(t.orgId, t.familyThreadId, t.createdAt, t.threadId),
    index("idx_thread_relationships_parent").on(t.orgId, t.parentThreadId, t.createdAt, t.threadId),
  ],
);

export const childThreadBatches = pgTable(
  "child_thread_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    parentThreadId: text("parent_thread_id").notNull(),
    parentRunId: text("parent_run_id").notNull(),
    familyThreadId: text("family_thread_id").notNull(),
    actorId: text("actor_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    itemCount: integer("item_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("child_thread_batches_key_check", sql`length(${t.idempotencyKey}) BETWEEN 1 AND 240`),
    check("child_thread_batches_fingerprint_check", sql`${t.requestFingerprint} ~ '^[0-9a-f]{64}$'`),
    check("child_thread_batches_count_check", sql`${t.itemCount} BETWEEN 1 AND 20`),
    foreignKey({
      name: "fk_child_thread_batches_parent",
      columns: [t.orgId, t.parentThreadId],
      foreignColumns: [threadRelationships.orgId, threadRelationships.threadId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_child_thread_batches_family",
      columns: [t.orgId, t.familyThreadId],
      foreignColumns: [threadRelationships.orgId, threadRelationships.threadId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_child_thread_batches_parent_run",
      columns: [t.orgId, t.parentRunId],
      foreignColumns: [runs.orgId, runs.id],
    }).onDelete("restrict"),
    uniqueIndex("uq_child_thread_batches_replay").on(t.orgId, t.parentThreadId, t.idempotencyKey),
    uniqueIndex("uq_child_thread_batches_org_id").on(t.orgId, t.id),
    index("idx_child_thread_batches_family").on(t.orgId, t.familyThreadId, t.createdAt, t.id),
  ],
);

export const childThreadBatchItems = pgTable(
  "child_thread_batch_items",
  {
    batchId: uuid("batch_id").notNull(),
    orgId: text("org_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    childThreadId: text("child_thread_id").notNull(),
    childRunId: text("child_run_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "child_thread_batch_items_batch_ordinal_pk", columns: [t.batchId, t.ordinal] }),
    check("child_thread_batch_items_ordinal_check", sql`${t.ordinal} BETWEEN 0 AND 19`),
    check("child_thread_batch_items_root_check", sql`${t.childRunId} = ${t.childThreadId}`),
    foreignKey({
      name: "fk_child_thread_batch_items_batch",
      columns: [t.orgId, t.batchId],
      foreignColumns: [childThreadBatches.orgId, childThreadBatches.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_child_thread_batch_items_relationship",
      columns: [t.orgId, t.childThreadId],
      foreignColumns: [threadRelationships.orgId, threadRelationships.threadId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_child_thread_batch_items_run",
      columns: [t.orgId, t.childRunId],
      foreignColumns: [runs.orgId, runs.id],
    }).onDelete("restrict"),
    uniqueIndex("uq_child_thread_batch_items_child").on(t.orgId, t.childThreadId),
  ],
);

export type ThreadRelationshipRow = typeof threadRelationships.$inferSelect;
