import { sql } from "drizzle-orm";
import {
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
import { artifacts } from "./artifacts";

export const artifactQualityReceipts = pgTable(
  "artifact_quality_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    artifactId: uuid("artifact_id").notNull(),
    threadId: text("thread_id").notNull(),
    artifactRevision: integer("artifact_revision").notNull(),
    subjectDigest: text("subject_digest").notNull(),
    qualityProfile: text("quality_profile").notNull(),
    exportFormat: text("export_format").notNull(),
    exportDigest: text("export_digest").notNull(),
    visualDigest: text("visual_digest").notNull(),
    inspectorVersion: text("inspector_version").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("artifact_quality_receipts_revision_check", sql`${t.artifactRevision} >= 0`),
    check(
      "artifact_quality_receipts_digest_check",
      sql`${t.subjectDigest} ~ '^[0-9a-f]{64}$' AND ${t.exportDigest} ~ '^[0-9a-f]{64}$' AND ${t.visualDigest} ~ '^[0-9a-f]{64}$' AND ${t.idempotencyKeyHash} ~ '^[0-9a-f]{64}$' AND ${t.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "artifact_quality_receipts_profile_check",
      sql`length(${t.qualityProfile}) BETWEEN 1 AND 128 AND ${t.qualityProfile} ~ '^[a-z0-9][a-z0-9._-]{0,127}$'`,
    ),
    check(
      "artifact_quality_receipts_export_format_check",
      sql`length(${t.exportFormat}) BETWEEN 1 AND 64 AND ${t.exportFormat} ~ '^[a-z0-9][a-z0-9._+-]{0,63}$'`,
    ),
    check(
      "artifact_quality_receipts_inspector_version_check",
      sql`length(${t.inspectorVersion}) BETWEEN 1 AND 128 AND ${t.inspectorVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$'`,
    ),
    foreignKey({
      name: "fk_artifact_quality_receipts_artifact_scope",
      columns: [t.orgId, t.artifactId, t.threadId],
      foreignColumns: [artifacts.orgId, artifacts.id, artifacts.threadId],
    }),
    uniqueIndex("uq_artifact_quality_receipts_org_idempotency").on(
      t.orgId,
      t.idempotencyKeyHash,
    ),
    uniqueIndex("uq_artifact_quality_receipts_current_subject_profile").on(
      t.orgId,
      t.artifactId,
      t.threadId,
      t.artifactRevision,
      t.subjectDigest,
      t.qualityProfile,
    ),
    index("idx_artifact_quality_receipts_artifact_created").on(
      t.orgId,
      t.artifactId,
      t.createdAt,
    ),
  ],
);
