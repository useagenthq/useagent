import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";
import { runs } from "./runs";

export const GITHUB_CHANGE_SET_STATES = [
  "frozen",
  "publishing",
  "reconcile_required",
  "published",
] as const;
export type GitHubChangeSetState = (typeof GITHUB_CHANGE_SET_STATES)[number];

export const GITHUB_PUBLICATION_STATES = [
  "pending",
  "publishing",
  "reconcile_required",
  "published",
  "failed",
] as const;
export type GitHubPublicationState = (typeof GITHUB_PUBLICATION_STATES)[number];

export type GitHubChangeAction = "add" | "modify" | "delete" | "rename";
export type GitHubFileMode = "100644" | "100755" | "120000";

export interface GitHubChangeManifestFile {
  readonly path: string;
  readonly action: GitHubChangeAction;
  readonly sha256?: string;
  readonly sizeBytes?: number;
  readonly mode?: GitHubFileMode;
  readonly previousPath?: string;
}

/** Browser-safe metadata for an immutable change bundle. File bytes/patches stay
 * behind the storage boundary referenced by payload_storage_key. */
export interface GitHubChangeManifest {
  readonly version: 1;
  readonly files: readonly GitHubChangeManifestFile[];
  readonly title?: string;
  readonly summary?: string;
}

export const githubChangeSets = pgTable(
  "github_change_sets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    repoFullName: text("repo_full_name").notNull(),
    baseRef: text("base_ref").notNull(),
    baseSha: text("base_sha").notNull(),
    manifest: jsonb("manifest").$type<GitHubChangeManifest>().notNull(),
    manifestSizeBytes: integer("manifest_size_bytes").notNull(),
    payloadStorageKey: text("payload_storage_key").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    payloadSizeBytes: bigint("payload_size_bytes", { mode: "number" }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    state: text("state").$type<GitHubChangeSetState>().notNull().default("frozen"),
    frozenAt: timestamp("frozen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "github_change_sets_state_check",
      sql`${t.state} IN ('frozen', 'publishing', 'reconcile_required', 'published')`,
    ),
    check("github_change_sets_fingerprint_check", sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check("github_change_sets_payload_sha_check", sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "github_change_sets_base_sha_check",
      sql`${t.baseSha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`,
    ),
    check(
      "github_change_sets_manifest_bounds_check",
      sql`jsonb_typeof(${t.manifest}) = 'object' AND jsonb_typeof(${t.manifest}->'files') = 'array' AND jsonb_array_length(${t.manifest}->'files') BETWEEN 1 AND 200 AND ${t.manifestSizeBytes} BETWEEN 2 AND 65536 AND octet_length(${t.manifest}::text) <= 65536`,
    ),
    check(
      "github_change_sets_payload_size_check",
      sql`${t.payloadSizeBytes} BETWEEN 0 AND 26214400`,
    ),
    uniqueIndex("uq_github_change_sets_org_fingerprint").on(t.orgId, t.fingerprint),
    index("idx_github_change_sets_org_run_created").on(t.orgId, t.runId, t.createdAt),
    index("idx_github_change_sets_org_thread_created").on(t.orgId, t.threadId, t.createdAt),
    index("idx_github_change_sets_org_repo_created").on(t.orgId, t.repoFullName, t.createdAt),
    index("idx_github_change_sets_org_expiry").on(t.orgId, t.state, t.expiresAt),
  ],
);

export const githubPublicationReceipts = pgTable(
  "github_publication_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    changeSetId: uuid("change_set_id")
      .notNull()
      .references(() => githubChangeSets.id, { onDelete: "cascade" }),
    // The caller's idempotency key is never persisted in plaintext.
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    state: text("state").$type<GitHubPublicationState>().notNull().default("pending"),
    targetBranch: text("target_branch").notNull(),
    draft: boolean("draft").notNull().default(false),
    commitMessage: text("commit_message").notNull(),
    pullRequestTitle: text("pull_request_title").notNull(),
    pullRequestBody: text("pull_request_body").notNull(),
    headBranch: text("head_branch").notNull(),
    commitSha: text("commit_sha"),
    pullRequestNumber: integer("pull_request_number"),
    pullRequestUrl: text("pull_request_url"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "github_publication_receipts_state_check",
      sql`${t.state} IN ('pending', 'publishing', 'reconcile_required', 'published', 'failed')`,
    ),
    check(
      "github_publication_receipts_idempotency_hash_check",
      sql`${t.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "github_publication_receipts_request_fingerprint_check",
      sql`${t.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "github_publication_receipts_attempt_count_check",
      sql`${t.attemptCount} BETWEEN 0 AND 100`,
    ),
    check(
      "github_publication_receipts_claim_check",
      sql`(${t.claimToken} IS NULL AND ${t.claimExpiresAt} IS NULL) OR (${t.claimToken} IS NOT NULL AND ${t.claimExpiresAt} IS NOT NULL)`,
    ),
    uniqueIndex("uq_github_publication_receipts_org_idempotency").on(
      t.orgId,
      t.idempotencyKeyHash,
    ),
    uniqueIndex("uq_github_publication_receipts_org_change_set").on(t.orgId, t.changeSetId),
    index("idx_github_publication_receipts_change_set_state").on(t.changeSetId, t.state),
    index("idx_github_publication_receipts_claim_expiry").on(t.state, t.claimExpiresAt),
    index("idx_github_publication_receipts_org_created").on(t.orgId, t.createdAt),
  ],
);
