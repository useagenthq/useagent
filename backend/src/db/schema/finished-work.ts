import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { artifacts } from "./artifacts";
import { runs } from "./runs";

export const FINISHED_WORK_SOURCE_KINDS = [
  "gateway_tool",
  "provider_native",
  "sandbox_output",
] as const;
export type FinishedWorkSourceKind = (typeof FINISHED_WORK_SOURCE_KINDS)[number];

export const FINISHED_WORK_OBLIGATION_AUTHORITIES = [
  "integration_gateway",
  "provider_adapter",
] as const;
export type FinishedWorkObligationAuthority = (typeof FINISHED_WORK_OBLIGATION_AUTHORITIES)[number];

export const FINISHED_WORK_REQUIREMENTS = [
  "artifact_create",
  "artifact_update",
  "external_action",
] as const;
export type FinishedWorkRequirement = (typeof FINISHED_WORK_REQUIREMENTS)[number];

export const FINISHED_WORK_OBLIGATION_STATES = [
  "open",
  "satisfied",
  "failed",
  "waived",
] as const;
export type FinishedWorkObligationState = (typeof FINISHED_WORK_OBLIGATION_STATES)[number];

export const FINISHED_WORK_RECEIPT_KINDS = [
  "artifact_created",
  "artifact_updated",
  "repository_changed",
  "external_action_completed",
  "read_only_answer",
] as const;
export type FinishedWorkReceiptKind = (typeof FINISHED_WORK_RECEIPT_KINDS)[number];

export const FINISHED_WORK_RECEIPT_AUTHORITIES = [
  "artifact_store",
  "workpiece_store",
  "github_publication",
  "slack_outbox",
  "integration_gateway",
  "run_engine",
] as const;
export type FinishedWorkReceiptAuthority = (typeof FINISHED_WORK_RECEIPT_AUTHORITIES)[number];

export interface FinishedWorkReceiptMetadata {
  readonly count?: number;
  readonly itemCount?: number;
  readonly byteCount?: number;
  readonly digest?: string;
  readonly mime?: string;
  readonly provider?: string;
  readonly action?: string;
  readonly commitSha?: string;
  readonly pullRequestUrl?: string;
}

export const finishedWorkObligations = pgTable(
  "finished_work_obligations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    runId: text("run_id").notNull(),
    threadId: text("thread_id").notNull(),
    sourceKind: text("source_kind").$type<FinishedWorkSourceKind>().notNull(),
    authority: text("authority").$type<FinishedWorkObligationAuthority>().notNull(),
    sourceKey: text("source_key").notNull(),
    requirement: text("requirement").$type<FinishedWorkRequirement>().notNull(),
    state: text("state").$type<FinishedWorkObligationState>().notNull().default("open"),
    sourceProvider: text("source_provider"),
    sourceCallId: text("source_call_id"),
    candidateName: text("candidate_name"),
    targetArtifactId: uuid("target_artifact_id").references(() => artifacts.id),
    materializedArtifactId: uuid("materialized_artifact_id").references(() => artifacts.id),
    materializedArtifactRevision: integer("materialized_artifact_revision"),
    failureCode: text("failure_code"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "finished_work_obligations_source_kind_check",
      sql`${t.sourceKind} IN ('gateway_tool', 'provider_native', 'sandbox_output')`,
    ),
    check(
      "finished_work_obligations_authority_check",
      sql`(${t.sourceKind} IN ('gateway_tool', 'sandbox_output') AND ${t.authority} = 'integration_gateway') OR (${t.sourceKind} = 'provider_native' AND ${t.authority} = 'provider_adapter')`,
    ),
    check(
      "finished_work_obligations_requirement_check",
      sql`${t.requirement} IN ('artifact_create', 'artifact_update', 'external_action')`,
    ),
    check(
      "finished_work_obligations_state_check",
      sql`${t.state} IN ('open', 'satisfied', 'failed', 'waived')`,
    ),
    check(
      "finished_work_obligations_source_key_check",
      sql`length(${t.sourceKey}) BETWEEN 1 AND 256 AND ${t.sourceKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$'`,
    ),
    check(
      "finished_work_obligations_source_provider_check",
      sql`${t.sourceProvider} IS NULL OR (length(${t.sourceProvider}) BETWEEN 1 AND 64 AND ${t.sourceProvider} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')`,
    ),
    check(
      "finished_work_obligations_source_call_check",
      sql`${t.sourceCallId} IS NULL OR (length(${t.sourceCallId}) BETWEEN 1 AND 256 AND ${t.sourceCallId} ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$')`,
    ),
    check(
      "finished_work_obligations_candidate_name_check",
      sql`${t.candidateName} IS NULL OR (length(${t.candidateName}) BETWEEN 1 AND 255 AND ${t.candidateName} !~ '[\\/\\\\[:cntrl:]]' AND ${t.candidateName} !~* '^[a-z][a-z0-9+.-]*://')`,
    ),
    check(
      "finished_work_obligations_failure_code_check",
      sql`${t.failureCode} IS NULL OR (${t.state} = 'failed' AND length(${t.failureCode}) BETWEEN 1 AND 64 AND ${t.failureCode} ~ '^[a-z][a-z0-9_.-]{0,63}$')`,
    ),
    check(
      "finished_work_obligations_resolution_check",
      sql`(${t.resolvedAt} IS NULL) = (${t.state} = 'open')`,
    ),
    check(
      "finished_work_obligations_update_target_check",
      sql`${t.requirement} <> 'artifact_update' OR ${t.targetArtifactId} IS NOT NULL`,
    ),
    check(
      "finished_work_obligations_materialization_check",
      sql`(${t.materializedArtifactId} IS NULL AND ${t.materializedArtifactRevision} IS NULL) OR (${t.materializedArtifactId} IS NOT NULL AND ${t.materializedArtifactRevision} >= 0)`,
    ),
    foreignKey({
      name: "fk_finished_work_obligations_run_scope",
      columns: [t.orgId, t.runId, t.threadId],
      foreignColumns: [runs.orgId, runs.id, runs.threadId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_finished_work_obligations_target_artifact_scope",
      columns: [t.orgId, t.targetArtifactId, t.threadId],
      foreignColumns: [artifacts.orgId, artifacts.id, artifacts.threadId],
    }),
    foreignKey({
      name: "fk_finished_work_obligations_materialized_artifact_scope",
      columns: [t.orgId, t.materializedArtifactId, t.threadId],
      foreignColumns: [artifacts.orgId, artifacts.id, artifacts.threadId],
    }),
    uniqueIndex("uq_finished_work_obligations_run_source").on(t.runId, t.sourceKey),
    uniqueIndex("uq_finished_work_obligations_scope_id").on(t.orgId, t.runId, t.threadId, t.id),
    index("idx_finished_work_obligations_run_state").on(t.runId, t.state, t.openedAt, t.id),
  ],
);

export const finishedWorkReceipts = pgTable(
  "finished_work_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    runId: text("run_id").notNull(),
    threadId: text("thread_id").notNull(),
    obligationId: uuid("obligation_id"),
    kind: text("kind").$type<FinishedWorkReceiptKind>().notNull(),
    authority: text("authority").$type<FinishedWorkReceiptAuthority>().notNull(),
    sourceKey: text("source_key").notNull(),
    artifactId: uuid("artifact_id").references(() => artifacts.id),
    artifactRevision: integer("artifact_revision"),
    externalRef: text("external_ref"),
    metadata: jsonb("metadata").$type<FinishedWorkReceiptMetadata>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "finished_work_receipts_kind_check",
      sql`${t.kind} IN ('artifact_created', 'artifact_updated', 'repository_changed', 'external_action_completed', 'read_only_answer')`,
    ),
    check(
      "finished_work_receipts_authority_check",
      sql`${t.authority} IN ('artifact_store', 'workpiece_store', 'github_publication', 'slack_outbox', 'integration_gateway', 'run_engine') AND ((${t.kind} IN ('artifact_created', 'artifact_updated') AND ${t.authority} IN ('artifact_store', 'workpiece_store')) OR (${t.kind} = 'repository_changed' AND ${t.authority} = 'github_publication') OR (${t.kind} = 'external_action_completed' AND ${t.authority} IN ('github_publication', 'slack_outbox', 'integration_gateway')) OR (${t.kind} = 'read_only_answer' AND ${t.authority} = 'run_engine'))`,
    ),
    check(
      "finished_work_receipts_source_key_check",
      sql`length(${t.sourceKey}) BETWEEN 1 AND 256 AND ${t.sourceKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$'`,
    ),
    check(
      "finished_work_receipts_artifact_check",
      sql`${t.kind} NOT IN ('artifact_created', 'artifact_updated') OR ${t.artifactId} IS NOT NULL`,
    ),
    check(
      "finished_work_receipts_artifact_revision_check",
      sql`${t.artifactRevision} IS NULL OR (${t.artifactId} IS NOT NULL AND ${t.artifactRevision} >= 0)`,
    ),
    check(
      "finished_work_receipts_external_ref_check",
      sql`${t.externalRef} IS NULL OR (length(${t.externalRef}) BETWEEN 1 AND 256 AND ${t.externalRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$')`,
    ),
    check(
      "finished_work_receipts_metadata_check",
      sql`jsonb_typeof(${t.metadata}) = 'object' AND octet_length(${t.metadata}::text) <= 8192 AND (${t.metadata} - 'count' - 'itemCount' - 'byteCount' - 'digest' - 'mime' - 'provider' - 'action' - 'commitSha' - 'pullRequestUrl') = '{}'::jsonb AND (NOT (${t.metadata} ? 'count') OR (jsonb_typeof(${t.metadata}->'count') = 'number' AND ((${t.metadata}->>'count')::numeric % 1) = 0 AND (${t.metadata}->>'count')::numeric >= 0)) AND (NOT (${t.metadata} ? 'itemCount') OR (jsonb_typeof(${t.metadata}->'itemCount') = 'number' AND ((${t.metadata}->>'itemCount')::numeric % 1) = 0 AND (${t.metadata}->>'itemCount')::numeric >= 0)) AND (NOT (${t.metadata} ? 'byteCount') OR (jsonb_typeof(${t.metadata}->'byteCount') = 'number' AND ((${t.metadata}->>'byteCount')::numeric % 1) = 0 AND (${t.metadata}->>'byteCount')::numeric >= 0)) AND (NOT (${t.metadata} ? 'digest') OR (jsonb_typeof(${t.metadata}->'digest') = 'string' AND ${t.metadata}->>'digest' ~ '^[0-9A-Fa-f]{64}$')) AND (NOT (${t.metadata} ? 'mime') OR (jsonb_typeof(${t.metadata}->'mime') = 'string' AND length(${t.metadata}->>'mime') BETWEEN 3 AND 127 AND ${t.metadata}->>'mime' ~ '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}$')) AND (NOT (${t.metadata} ? 'provider') OR (jsonb_typeof(${t.metadata}->'provider') = 'string' AND length(${t.metadata}->>'provider') BETWEEN 1 AND 64 AND ${t.metadata}->>'provider' ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$')) AND (NOT (${t.metadata} ? 'action') OR (jsonb_typeof(${t.metadata}->'action') = 'string' AND length(${t.metadata}->>'action') BETWEEN 1 AND 64 AND ${t.metadata}->>'action' ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$')) AND (NOT (${t.metadata} ? 'commitSha') OR (jsonb_typeof(${t.metadata}->'commitSha') = 'string' AND ${t.metadata}->>'commitSha' ~ '^[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?$')) AND (NOT (${t.metadata} ? 'pullRequestUrl') OR (jsonb_typeof(${t.metadata}->'pullRequestUrl') = 'string' AND length(${t.metadata}->>'pullRequestUrl') BETWEEN 1 AND 2048 AND ${t.metadata}->>'pullRequestUrl' ~ '^https://github[.]com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*$' AND split_part(${t.metadata}->>'pullRequestUrl', '/', 4) NOT IN ('.', '..') AND split_part(${t.metadata}->>'pullRequestUrl', '/', 5) NOT IN ('.', '..') AND ${t.metadata}->>'pullRequestUrl' = 'https://github.com/' || split_part(${t.metadata}->>'pullRequestUrl', '/', 4) || '/' || split_part(${t.metadata}->>'pullRequestUrl', '/', 5) || '/pull/' || split_part(${t.metadata}->>'pullRequestUrl', '/', 7)))`,
    ),
    foreignKey({
      name: "fk_finished_work_receipts_run_scope",
      columns: [t.orgId, t.runId, t.threadId],
      foreignColumns: [runs.orgId, runs.id, runs.threadId],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_finished_work_receipts_obligation_scope",
      columns: [t.orgId, t.runId, t.threadId, t.obligationId],
      foreignColumns: [
        finishedWorkObligations.orgId,
        finishedWorkObligations.runId,
        finishedWorkObligations.threadId,
        finishedWorkObligations.id,
      ],
    }),
    foreignKey({
      name: "fk_finished_work_receipts_artifact_scope",
      columns: [t.orgId, t.artifactId, t.threadId],
      foreignColumns: [artifacts.orgId, artifacts.id, artifacts.threadId],
    }),
    uniqueIndex("uq_finished_work_receipts_run_source").on(t.runId, t.sourceKey),
    uniqueIndex("uq_finished_work_receipts_obligation")
      .on(t.obligationId)
      .where(sql`${t.obligationId} IS NOT NULL`),
    index("idx_finished_work_receipts_run_created").on(t.runId, t.createdAt, t.id),
  ],
);
