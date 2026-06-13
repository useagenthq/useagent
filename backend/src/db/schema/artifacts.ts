import type {
  ArtifactProposalStatus,
  ArtifactWorkpieceKind,
  ArtifactWorkpieceState,
} from "@useagent/artifact-workspace";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { runs } from "./runs";

// ---------------------------------------------------------------------------
// Durable run artifacts. Bytes live behind the ArtifactStorage boundary; this
// table stores only tenant/run identity, immutable content metadata, and the
// opaque storage key. Re-publishing the exact same run path + digest is
// idempotent, while changing the file at that path creates a new version.
// ---------------------------------------------------------------------------

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    sourcePath: text("source_path").notNull(),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    workpieceKind: text("workpiece_kind").$type<ArtifactWorkpieceKind>(),
    workpieceState: jsonb("workpiece_state").$type<ArtifactWorkpieceState>(),
    workpieceRevision: integer("workpiece_revision").notNull().default(0),
    // Content-addressed storage key of a rendered PDF preview (from an in-sandbox
    // soffice conversion of an Office binary). Null when no preview was produced;
    // served read-only from the same ArtifactStorage as the bytes.
    previewStorageKey: text("preview_storage_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_artifacts_run_path_sha").on(t.runId, t.sourcePath, t.sha256),
    uniqueIndex("uq_artifacts_finished_work_scope").on(t.orgId, t.id, t.threadId),
    index("idx_artifacts_org_created").on(t.orgId, t.createdAt),
    index("idx_artifacts_thread_created").on(t.threadId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Agent-proposed workpiece revisions (the "proposed changes" lane). When an
// agent edits an existing workpiece mid-run, the edit lands here as a PROPOSED
// revision instead of mutating mainline (artifacts.workpieceState /
// workpieceRevision). Mainline stays whatever the user last accepted or saved.
// A proposal folds into mainline only on an explicit, authenticated accept; a
// dismissed proposal is recorded (status="dismissed"), never vaporized. Human
// edits through the workpiece PATCH route keep writing mainline directly.
// ---------------------------------------------------------------------------

export const artifactWorkpieceProposals = pgTable(
  "artifact_workpiece_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    // The run whose agent proposed this revision (provenance). May differ from
    // the run that originally created the artifact.
    proposerRunId: text("proposer_run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ArtifactWorkpieceKind>().notNull(),
    // The artifacts.workpieceRevision the proposal was authored against.
    baseRevision: integer("base_revision").notNull(),
    // Full proposed workpiece state (whole-document, applied on accept).
    state: jsonb("state").$type<ArtifactWorkpieceState>().notNull(),
    summary: text("summary"),
    status: text("status").$type<ArtifactProposalStatus>().notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // The user who accepted/dismissed; null when resolved by a system actor.
    resolvedBy: text("resolved_by"),
    // The mainline revision this proposal produced on accept (provenance link).
    resolvedRevision: integer("resolved_revision"),
  },
  (t) => [
    index("idx_artifact_proposals_artifact_status").on(t.artifactId, t.status),
    index("idx_artifact_proposals_org_created").on(t.orgId, t.createdAt),
    index("idx_artifact_proposals_run").on(t.proposerRunId),
  ],
);
