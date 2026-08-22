import {
  PROVIDER_CONNECTION_AUTH_METHODS,
  PROVIDER_CONNECTION_PROVIDERS,
  PROVIDER_CONNECTION_STATUSES,
  type ProviderConnectionAuthMethod,
  type ProviderConnectionMetadata,
  type ProviderConnectionProvider,
  type ProviderConnectionStatus,
} from "@skynet/agent-client/provider-connections";
import type {
  ArtifactProposalStatus,
  ArtifactWorkpieceKind,
  ArtifactWorkpieceState,
} from "@skynet/artifact-workspace";
import type { RunResource } from "../resources/types";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type {
  ProviderConnectionAuthMethod,
  ProviderConnectionMetadata,
  ProviderConnectionProvider,
  ProviderConnectionStatus,
};
export {
  PROVIDER_CONNECTION_AUTH_METHODS,
  PROVIDER_CONNECTION_PROVIDERS,
  PROVIDER_CONNECTION_STATUSES,
};

// ---------------------------------------------------------------------------
// Shared domain types
// ---------------------------------------------------------------------------

export type RunStatus = "queued" | "running" | "completed" | "failed";
export type StepKind = "command" | "file" | "task" | "done";

/** Which team-memory pool a run reads and writes (see src/memory/scope.ts).
 *  - "org": read + capture ORGANIZATION memory only (every org member shares it).
 *  - "personal": read the actor's PERSONAL memory AND org memory (merged); capture
 *    into personal ONLY. A personal run with no authenticated user fails closed.
 *  This is the ACCEPTED set at the API boundary; a run's scope is server-persisted,
 *  never taken from the sandbox/prompt/tool at recall time. */
export const MEMORY_SCOPES = ["org", "personal"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** Which harness executes a run. `mock` is the scripted trace; `chat` is the
 *  no-sandbox conversational OpenRouter path; the agent engines (opencode /
 *  claude / codex) execute inside the selected per-thread Cube or Daytona
 *  sandbox. `daytona` and `claude-sdk` are legacy ids kept so
 *  pre-consolidation rows still resolve (aliased in the registry); `acp` is the
 *  ACP bridge (registered, hidden from the UI). This list is THE accepted set at
 *  every API boundary (runs, schedules, Slack default). */
export const ENGINE_IDS = [
  "mock",
  "opencode",
  "claude",
  "codex",
  "chat",
  "daytona",
  "claude-sdk",
  "acp",
] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export interface SkillSections {
  overview: string[];
  procedure: string[];
  verify: string[];
}

// A skill row is one of two user-facing kinds over the SAME substrate (mem_op:
// "treat playbooks as versioned skills/content, not a second executor"). A
// "playbook" is just a skill surfaced as a structured Overview/Procedure/Verify
// procedure. Immutable per row — an edit mints a new content version, never a
// kind change.
export const SKILL_KINDS = ["skill", "playbook"] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

// ---------------------------------------------------------------------------
// Runs + steps — the durable event log (ARCHITECTURE.md step 1), now on
// Postgres. `org_id` / `user_id` are nullable so legacy/system runs still fit.
// ---------------------------------------------------------------------------

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id"),
    userId: text("user_id"),
    prompt: text("prompt").notNull(),
    model: text("model").notNull(),
    engine: text("engine").$type<EngineId>().notNull().default("mock"),
    status: text("status").$type<RunStatus>().notNull(),
    summary: text("summary"),
    durationMs: integer("duration_ms"),
    // Run threading. A reply points `parent_run_id` at the run it follows;
    // `thread_id` is the root run's id, shared by the whole chain (a root run's
    // thread_id equals its own id). Prompts stay clean — the engine context is
    // composed server-side by walking the thread, never nested into the prompt.
    parentRunId: text("parent_run_id").references((): AnyPgColumn => runs.id),
    threadId: text("thread_id").notNull(),
    // The engine's OWN session id for this run (opencode ses_*, claude-sdk UUID,
    // codex session id). Persisted so the thread's next turn resumes the engine's
    // native conversation EXPLICITLY by id — reference bot's set_resume_session_id
    // model — instead of relying on "most recent" heuristics. Null for engines
    // without native sessions (mock) or pre-feature runs.
    engineSessionId: text("engine_session_id"),
    // The Daytona sandbox this run executed in. Persisted so the thread→sandbox
    // mapping SURVIVES backend restarts — the next turn resumes the same box
    // (workspace + resident engine server) instead of provisioning a new one.
    sandboxId: text("sandbox_id"),
    // The GitHub repository this run works in ("owner/name"), chosen in the New
    // Task composer and validated against GET /api/repos. Nullable — a run with
    // no repo works in a bare sandbox workdir. Inherited across a thread (a reply
    // keeps its root run's repo) so the adapter always knows the thread's repo.
    repo: text("repo"),
    // Multi-repo selection (multi-repo): the GitHub repos this thread works in,
    // validated against GET /api/repos. jsonb string[]; empty = a bare workdir;
    // inherited across a thread. Each entry is "owner/name" for the default
    // branch, OR "owner/name:branch" when a branch was chosen - the ":branch"
    // suffix carries a per-repo branch WITHOUT a schema change (see
    // github/repo-ref.ts; ":" is invalid in both a repo ref and a git ref name,
    // so decoding is unambiguous). Decoded at read time - the API exposes clean
    // "owner/name" in `repos` plus the branch in `repo_specs`. `repo` above is the
    // legacy single-value mirror (clean repos[0] ?? null), kept for back-compat.
    repos: jsonb("repos").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // Typed resources accepted at the run boundary. These are the durable,
    // authorized identities used by downstream tools; legacy rows and callers
    // intentionally read as an empty list.
    resolvedResources: jsonb("resolved_resources")
      .$type<RunResource[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Which team-memory pool this run reads/writes. Default "org" so every
    // pre-existing (pre-migration) run behaves as an organization-scoped run.
    // A reply inherits its parent's scope unless the authenticated user changes
    // it; resolution/validation lives at the run-creation boundary (routes.ts).
    memoryScope: text("memory_scope").$type<MemoryScope>().notNull().default("org"),
    // Pinned skill/playbook selection for this run — an immutable REFERENCE to a
    // `skill_revisions` row (skill_id + skill_version) plus its content hash. Set
    // when a skill was selected in the composer/run-now; null otherwise. The
    // worker materializes the revision's formatted SKILL.md into the engine's
    // context SEPARATELY from the (clean) user prompt, and emits `skill.loaded`.
    // A later skill edit creates a NEW version, so a historical run's pinned
    // version — and thus its context — never changes.
    skillId: text("skill_id"),
    skillVersion: integer("skill_version"),
    skillContentHash: text("skill_content_hash"),
    /** Set ONLY for a VALIDATED native provider command turn (Phase 3): the command name,
     *  checked against the active session catalog at acceptance. Non-null => the prompt is the
     *  exact `/name args` bytes and the worker delivers it verbatim with no injected context. */
    commandName: text("command_name"),
    /** The ACCEPTED command IDENTITY persisted alongside the name (fail-closed authorization): the
     *  provider, the native session, and the catalog snapshot revision it was authorized against,
     *  so the worker can re-validate against the LIVE session before sending and history records
     *  exactly what authorized it. Null for a non-command run. */
    commandProvider: text("command_provider"),
    commandSessionId: text("command_session_id"),
    commandCatalogRevision: bigint("command_catalog_revision", { mode: "number" }),
    // First-class INTERNAL-run marker (memory self-improvement item 2). Set only
    // by server-owned acceptance to an exact trusted `internal:*` origin (see
    // src/runs/origin.ts). Public identifiers never influence it. Internal
    // runs (parity canaries, e2e/soak harnesses, QC probes) are excluded from
    // org-memory capture so evaluation traffic never pollutes team memory.
    origin: text("origin"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_runs_created").on(t.createdAt),
    index("idx_runs_org").on(t.orgId),
    index("idx_runs_thread").on(t.threadId),
  ],
);

export const steps = pgTable(
  "steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    idx: integer("idx").notNull(),
    kind: text("kind").$type<StepKind>().notNull(),
    label: text("label").notNull(),
    chip: text("chip"),
    codeJson: text("code_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_steps_run").on(t.runId, t.idx)],
);

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

/**
 * Canonical agent-event lane (final_harness Phase 1). Provider-neutral events the
 * backend translates every harness INTO (see src/engines/canonical.ts). Persisted
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
    ts: bigint("ts", { mode: "number" }).notNull(), // Skynet-assigned ms epoch
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
 * Durable canonicalization outbox (final_harness Phase 1 hardening). One row per run,
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

// ---------------------------------------------------------------------------
// Skills — org-scoped reusable playbooks.
// ---------------------------------------------------------------------------

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    // "skill" (default) or "playbook" — the SAME substrate surfaced under two
    // product labels (mem_op: not a second executor). Immutable per row.
    kind: text("kind").$type<SkillKind>().notNull().default("skill"),
    description: text("description").notNull().default(""),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // The skill's LATEST instruction content. `skill_revisions` holds the
    // immutable history; this is a convenience mirror of the current version's
    // content. An edit bumps `currentVersion` and appends a new revision.
    sections: jsonb("sections").$type<SkillSections>().notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    // Provenance for a skill imported from a GitHub repo (multi-repo). Null for
    // hand-authored skills. (org_id, source_repo, source_path) is the import
    // identity — a re-import that finds changed content appends a revision and
    // advances `source_sha` to the commit the new content was read at; unchanged
    // content is a no-op. See src/github/discovery.ts + src/skills/import.ts.
    sourceRepo: text("source_repo"),
    sourcePath: text("source_path"),
    sourceSha: text("source_sha"),
    usageCount: integer("usage_count").notNull().default(0),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("uq_skills_org_name").on(t.orgId, t.name)],
);

// Immutable skill revisions — every version of a skill's instruction content,
// snapshotted at create/edit time. A run pins one revision (skill_id + version);
// because revisions are never mutated, a later edit (which appends a NEW row)
// cannot alter a historical run's loaded content. `content_hash` is the sha256 of
// the formatted SKILL.md, the addressable identity emitted in `skill.loaded`.
export const skillRevisions = pgTable(
  "skill_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // Denormalized from `skills.kind` so the worker materializes + attributes a
    // pinned revision (skill.loaded marker) from a single-table read. Immutable,
    // so no update anomaly vs the parent row.
    kind: text("kind").$type<SkillKind>().notNull().default("skill"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    sections: jsonb("sections").$type<SkillSections>().notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("uq_skill_rev").on(t.skillId, t.version)],
);

// ---------------------------------------------------------------------------
// Human-governed learning lane (memory self-improvement items 4 + 6). NOTHING
// in this lane auto-publishes:
//  - a HIGH-VALUE completed run (published artifacts, or a long multi-tool run;
//    see src/learning/salience.ts) produces a knowledge DRAFT here — never a
//    knowledge_records row. Only an explicit org-admin accept turns a draft
//    into real, agent-searchable knowledge (via the existing store upsert).
//  - repeated ACCEPTED drafts (deterministic title-keyword similarity; see
//    src/learning/similarity.ts) surface a skill revision PROPOSAL, which
//    changes a live skill only on an explicit org-admin accept through the
//    existing skills code path (createSkillWithRevision/updateSkillWithRevision).
// Both tables are written ONLY by the trusted backend (producer hook + admin
// routes) — the sandbox gateway never touches them, so no gateway grants.
// ---------------------------------------------------------------------------

export const KNOWLEDGE_DRAFT_STATUSES = ["draft", "accepted", "dismissed"] as const;
export type KnowledgeDraftStatus = (typeof KNOWLEDGE_DRAFT_STATUSES)[number];

/** Why the producer judged the source run high-value (deterministic salience). */
export type KnowledgeDraftReason = "published_artifacts" | "long_multi_tool_run";

/** One step of a draft's ordered executable procedure trace: the tool that ran,
 *  a one-line sanitized gist of its target (paths/commands/names, never secret
 *  values), and whether it terminally succeeded. */
export interface ProcedureTraceStep {
  tool: string;
  gist: string;
  ok: boolean;
}

/** One step of the Evidence-Model-v2 procedure (self_improving 6.2). The
 *  structural shape mirrors src/learning/procedure-v2.ts ProcedureStep; kept
 *  inline here so schema does not depend on the learning lane. Additive inside
 *  the evidence jsonb — no migration. */
export interface ProcedureStepV2 {
  ordinal: number;
  tool: string;
  operation: string;
  normalizedArgs: Record<string, unknown>;
  preconditions: string[];
  result: "succeeded" | "failed" | "reverted" | "unknown";
  verificationRefs: string[];
  sourceEventIds: string[];
}

/** The reviewable-asset class the verified-outcome gate assigned (6.4). */
export type LearningCandidateClass =
  | "personal_memory"
  | "knowledge_draft"
  | "playbook_proposal";

/** The deterministic facts a draft was proposed FROM — shown to the reviewer. */
export interface KnowledgeDraftEvidence {
  reason: KnowledgeDraftReason;
  engine: string;
  model: string;
  durationMs: number | null;
  stepCount: number;
  distinctStepKinds: number;
  artifactCount: number;
  artifactNames: string[];
  /** Ordered, bounded procedure trace (max ~40 steps) collected from the run's
   *  step rows at draft time. Optional + additive inside the evidence jsonb —
   *  pre-feature drafts simply lack it (no migration). */
  procedure?: ProcedureTraceStep[];
  /** How many trailing steps the trace cap elided (rendered honestly as
   *  "... N more steps"). Absent when nothing was elided. */
  procedureElided?: number;
  /** Evidence-Model-v2 (self_improving 6.2/6.3). The EXECUTABLE procedure
   *  (succeeded steps, order + repeats preserved) and ADVICE (failed/reverted
   *  recovery steps, retained but not executable). Additive; a run with no v2
   *  extraction simply lacks these. */
  procedureV2?: ProcedureStepV2[];
  advice?: ProcedureStepV2[];
  /** The verified-outcome gate's classification + whether a verified
   *  postcondition existed (artifact / passing test / user acceptance). */
  candidateClass?: LearningCandidateClass;
  verified?: boolean;
}

export const knowledgeDrafts = pgTable(
  "knowledge_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // The completed run the draft was distilled from (provenance + idempotency).
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    title: text("title").notNull(),
    /** Proposed knowledge body (markdown) — becomes the record body on accept. */
    content: text("content").notNull(),
    evidence: jsonb("evidence").$type<KnowledgeDraftEvidence>().notNull(),
    status: text("status").$type<KnowledgeDraftStatus>().notNull().default("draft"),
    /** The knowledge_records id the accept created (provenance link). */
    acceptedRecordId: text("accepted_record_id"),
    /** The user who accepted/dismissed; null while the draft is open. */
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One draft per run — the post-finalize producer is naturally idempotent.
    uniqueIndex("uq_knowledge_drafts_run").on(t.runId),
    index("idx_knowledge_drafts_org_status").on(t.orgId, t.status, t.createdAt),
  ],
);

export const SKILL_PROPOSAL_STATUSES = ["proposed", "accepted", "dismissed"] as const;
export type SkillProposalStatus = (typeof SKILL_PROPOSAL_STATUSES)[number];

export const skillRevisionProposals = pgTable(
  "skill_revision_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // The existing skill this proposes a revision OF; null = brand-new-skill
    // proposal. set null (not cascade): the proposal record outlives the skill.
    skillId: uuid("skill_id").references(() => skills.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Proposed instruction content — the SKILL.md text is derived from these
     *  sections via formatSkillMarkdown (one source of truth, no divergence). */
    sections: jsonb("sections").$type<SkillSections>().notNull(),
    /** The accepted knowledge_drafts ids the proposal was assembled from. */
    sourceDraftIds: jsonb("source_draft_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status").$type<SkillProposalStatus>().notNull().default("proposed"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** The skill + version the accept produced (provenance link). */
    resolvedSkillId: uuid("resolved_skill_id"),
    resolvedVersion: integer("resolved_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_skill_proposals_org_status").on(t.orgId, t.status, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Learning outbox (self_improving 6.1) — the DURABLE learning intent. A run's
// learning candidate used to be built AFTER finalizeRun committed (a crash in
// that gap lost it, and re-finalize/reconcile never re-armed it). This row is
// written INSIDE the finalization transaction for every eligible completed run,
// so "completed => learning intent enqueued" holds atomically. A boot-started
// delivery worker (src/learning/learning-outbox.ts) claims pending rows, builds
// the evidence-backed candidate, and writes the knowledge_draft — retryable,
// dead-lettering with an operator-visible reason, and it NEVER fails the
// already-completed run. Idempotent by run_id (one candidate per run, exactly
// like knowledge_drafts.uq_knowledge_drafts_run downstream).
// ---------------------------------------------------------------------------

export type LearningOutboxStatus = "pending" | "processing" | "done" | "dead";

export const learningOutbox = pgTable(
  "learning_outbox",
  {
    /** = runId — one learning candidate per run, so enqueue is idempotent. */
    runId: text("run_id").primaryKey(),
    orgId: text("org_id").notNull(),
    /** The run's authenticated actor (null for an org run with no user). */
    userId: text("user_id"),
    /** Which memory pool the run read/wrote — carried so a preference candidate
     *  is classified into the right pool without re-reading the run row. */
    memoryScope: text("memory_scope").$type<MemoryScope>().notNull().default("org"),
    /** The run's origin marker (src/runs/origin.ts); null for a real product run.
     *  Recorded for the operator; eligible runs are non-internal by construction. */
    origin: text("origin"),
    /** The candidate-builder policy version this intent was enqueued under, so a
     *  later builder change is auditable per row (self_improving 6.1). */
    policyVersion: integer("policy_version").notNull().default(1),
    status: text("status").$type<LearningOutboxStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    /** Earliest a pending row may be (re)processed — exponential backoff. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The worker claims due rows by (status, next_attempt_at).
    index("idx_learning_outbox_due").on(t.status, t.nextAttemptAt),
    index("idx_learning_outbox_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Org Secrets — org-scoped named secrets injected into the per-thread sandbox at
// boot (task #100). The value is AES-256-GCM encrypted at rest
// (src/secrets/crypto.ts); `iv` + `tag` are the GCM nonce and auth tag. The
// plaintext value is WRITE-ONLY at the API boundary — never returned by any
// route, only decrypted server-side for injection. `name` is an env-var
// identifier (^[A-Z][A-Z0-9_]*$), unique per org.
//
// `kind` selects HOW the secret reaches the sandbox:
//  - "env"  (default): injected as an environment variable NAME=value.
//  - "file": the decrypted value is materialized to a 0600 file inside the
//    sandbox and the env var is set to that PATH (for file-shaped creds like a
//    GCP service-account JSON or a PEM private key).
// ---------------------------------------------------------------------------

export const SECRET_KINDS = ["env", "file"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    // How the secret is injected: an env var value ("env") or a materialized
    // file whose PATH becomes the env var value ("file").
    kind: text("kind").$type<SecretKind>().notNull().default("env"),
    // base64 AES-256-GCM ciphertext of the value + its per-row iv and auth tag.
    valueCiphertext: text("value_ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_secrets_org_name").on(t.orgId, t.name)],
);

// ---------------------------------------------------------------------------
// Provider connections — per-user, per-organization credentials for model
// providers. These are NOT sandbox secrets: plaintext is write-only at the HTTP
// boundary and decrypted only by trusted backend callers. Metadata is limited to
// safe display fields; credential material is AES-256-GCM sealed with the shared
// secrets crypto implementation.
// ---------------------------------------------------------------------------

export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    provider: text("provider").$type<ProviderConnectionProvider>().notNull(),
    authMethod: text("auth_method").$type<ProviderConnectionAuthMethod>().notNull(),
    status: text("status").$type<ProviderConnectionStatus>().notNull(),
    metadata: jsonb("metadata")
      .$type<ProviderConnectionMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_provider_connections_org_user").on(t.orgId, t.userId),
    uniqueIndex("uq_provider_connections_scope").on(
      t.orgId,
      t.userId,
      t.provider,
      t.authMethod,
    ),
  ],
);

// Codex provider thread ids are subscription-account capabilities. Keep their
// ownership on the trusted host rather than accepting a resume cursor supplied
// by the sandbox. The auth epoch is part of the key so reconnecting an account
// cannot inherit thread access from the credential generation it replaced.
export const providerConnectionThreads = pgTable(
  "provider_connection_threads",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    productThreadId: text("product_thread_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    authEpoch: text("auth_epoch").notNull(),
    providerThreadId: text("provider_thread_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.orgId, t.userId, t.productThreadId, t.connectionId, t.authEpoch],
    }),
    uniqueIndex("uq_provider_connection_threads_provider_scope").on(
      t.connectionId,
      t.authEpoch,
      t.providerThreadId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Slack adapter — maps a Slack thread to the skynet run that ROOTED it, so a
// later reply in that Slack thread becomes a `parent_run_id` follow-up (shared
// thread, clean prompts). One row per Slack thread the bot has engaged; the
// composite key is the Slack thread's identity `(channel, thread root ts)`.
// ---------------------------------------------------------------------------

// Maps a Slack WORKSPACE (team id) to its tenant. `user_id` is the provisioning
// operator retained for compatibility; event attribution never uses it. A
// sender must have a separate slack_users row before accessing private data.
// Ingress fails CLOSED for an unmapped workspace.
export const slackWorkspaces = pgTable("slack_workspaces", {
  teamId: text("team_id").primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Verified Slack sender -> product user mapping. Workspace ownership alone is
// never enough to impersonate its operator: private resources require this
// per-sender identity, while unmapped senders may still create org-only runs.
export const slackUsers = pgTable(
  "slack_users",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => slackWorkspaces.teamId, { onDelete: "cascade" }),
    slackUserId: text("slack_user_id").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.slackUserId] })],
);

export const slackThreads = pgTable(
  "slack_threads",
  {
    teamId: text("team_id").notNull(),
    channel: text("channel").notNull(),
    threadTs: text("thread_ts").notNull(),
    rootRunId: text("root_run_id")
      .notNull()
      .references(() => runs.id),
    orgId: text("org_id").notNull(),
    // Slack message ts of the run CARD (Block Kit) posted into this thread, so
    // later progress/completion updates target the SAME message via chat.update.
    // Null until the card is posted (or when the card post failed and the plain
    // reply is used instead). One card per rooted Slack thread.
    cardTs: text("card_ts"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.channel, t.threadTs] })],
);

export const slackRunResponses = pgTable(
  "slack_run_responses",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    teamId: text("team_id").notNull(),
    channel: text("channel").notNull(),
    threadTs: text("thread_ts").notNull(),
    nativeStreamTs: text("native_stream_ts"),
    nativeStreamMode: text("native_stream_mode").$type<"task_update" | "plan">(),
    fallbackMessageTs: text("fallback_message_ts"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.teamId, t.channel, t.threadTs] }),
    index("idx_slack_run_responses_run").on(t.runId),
    index("idx_slack_run_responses_thread").on(t.teamId, t.channel, t.threadTs),
  ],
);

// ---------------------------------------------------------------------------
// Durable Slack connector outbox (north star "transactional connector outbox").
// Outbound Slack calls (the run-completion reply, the receipt reaction) are
// enqueued here as durable rows — a backend restart must not lose an undelivered
// reply. A delivery worker claims due rows, calls Slack, and on failure records
// a classified error + bounded exponential backoff; after `max_attempts` the row
// dead-letters. Slack 429s honor Retry-After. `idempotency_key` (UNIQUE)
// deduplicates enqueue and bounds delivery to once per logical message.
// ---------------------------------------------------------------------------

export type SlackOutboxState = "pending" | "delivering" | "delivered" | "dead";
// `upload_file` delivers a run-produced artifact into the thread. New rows carry
// only an immutable artifact id; legacy rows may still carry a staged path.
// `post_card`/`update_card` post + advance the Block Kit run card in place (the
// card ts is stored on slack_threads). `kind` is a text column, so a new kind
// needs no migration.
export type SlackOutboxKind =
  | "post_message"
  | "add_reaction"
  | "upload_file"
  | "post_card"
  | "update_card"
  | "set_session_status"
  | "start_stream"
  | "append_stream"
  | "stop_stream";
/** Classified delivery failure — drives retry vs dead-letter and observability. */
export type SlackErrorClass = "rate_limited" | "transient" | "permanent";

export const slackOutbox = pgTable(
  "slack_outbox",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    kind: text("kind").$type<SlackOutboxKind>().notNull(),
    /** Bounded JSON of the Slack call arguments (channel/text/threadTs, …). */
    payload: text("payload").notNull(),
    state: text("state").$type<SlackOutboxState>().notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    /** Earliest time a pending row may be (re)delivered — backoff / Retry-After. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    errorClass: text("error_class").$type<SlackErrorClass>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The delivery worker claims due rows by (state, next_attempt_at).
    index("idx_slack_outbox_due").on(t.state, t.nextAttemptAt),
  ],
);

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

// ---------------------------------------------------------------------------
// User-provided run inputs. Bytes reuse the content-addressed ArtifactStorage
// boundary, but uploads have their own lifecycle because they exist before a
// run. A ready upload is atomically claimed by exactly one run during durable
// command acceptance; ownership never comes from a prompt or sandbox.
// ---------------------------------------------------------------------------

export const userUploads = pgTable(
  "user_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("idx_user_uploads_owner_created").on(t.orgId, t.userId, t.createdAt),
    index("idx_user_uploads_run").on(t.runId),
    index("idx_user_uploads_expires").on(t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// Memory capture outbox (memory Phase 3b). Durable, retryable write-back of a
// run's outcome to team memory — replaces the old fire-and-forget POST that was
// lost on any failure. Mirrors slack_outbox's shape (a SEPARATE table by design;
// no shared outbox framework this cycle — convergence noted in the progress log).
//
// Memory-specific difference: AT-MOST-once delivery. /v3/conversation/add has no
// idempotency key, so a re-delivery would create a DUPLICATE L0 turn. A row
// orphaned in `delivering` by a crash is therefore left for MANUAL inspection —
// never auto-reset to pending — trading a rare lost capture for never
// duplicating a team-memory turn.
// ---------------------------------------------------------------------------

export type MemoryOutboxState = "pending" | "delivering" | "delivered" | "dead";

export const memoryOutbox = pgTable(
  "memory_outbox",
  {
    /** = runId — one capture per run, so enqueue is naturally idempotent. */
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    /** Bounded JSON: { identity, prompt, summary }. */
    payload: text("payload").notNull(),
    state: text("state").$type<MemoryOutboxState>().notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    /** Earliest a pending row may be (re)delivered — exponential backoff. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The delivery worker claims due rows by (state, next_attempt_at).
    index("idx_memory_outbox_due").on(t.state, t.nextAttemptAt),
  ],
);

// ---------------------------------------------------------------------------
// Reconcile queue (#63 adaptive post-boot reconciler). The one-shot boot probe
// honest-FAILS a run whose native session in fact completes moments after a fast
// restart (~21% of crash-storm kills). Instead, boot PARKS such a run here and a
// background loop re-probes it on a short backoff within a bounded budget: adopt
// the finished session on success, honest-fail only after the deadline. This row
// IS the durable "reconciling" marker — the run stays `running` and the parked
// state survives the reconciler's OWN restart because it lives in the DB, not
// memory. One row per parked run (run_id pk ⇒ re-park is idempotent, so a
// crash-looping backend preserves the original deadline).
// ---------------------------------------------------------------------------

export const reconcileQueue = pgTable(
  "reconcile_queue",
  {
    /** The parked run (still `running`). PK ⇒ enqueue is idempotent per run. */
    runId: text("run_id").primaryKey(),
    threadId: text("thread_id").notNull(),
    /** Native handle for the re-probe (opencode session in its Daytona sandbox). */
    sandboxId: text("sandbox_id").notNull(),
    sessionId: text("session_id").notNull(),
    /** Our last-activity watermark — a completed assistant message must be strictly
     *  newer than this to count as THIS turn's result (reconcile `sinceMs`). */
    sinceAt: timestamp("since_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Earliest the next re-probe may run (backoff 15s/30s/60s). */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** Park budget end — after this, honest-fail with the resumable summary. */
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The reconcile loop claims due rows by next_attempt_at.
    index("idx_reconcile_due").on(t.nextAttemptAt),
  ],
);

// ---------------------------------------------------------------------------
// Schedules — unattended autonomy. A schedule fires the existing run-creation
// path on a 5-field cron expression (the always-on 60s scheduler loop) or on a
// manual "run now". `enabled` defaults FALSE — reference bot's safety default, so an
// imported/created schedule never auto-fires until a human turns it on.
// ---------------------------------------------------------------------------

/** How a firing was triggered: the cron loop, or a manual "run now". */
export type ScheduleTrigger = "cron" | "manual";
export type AutomationJson = Record<string, unknown>;

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    name: text("name").notNull(),
    // 5-field cron expression ("min hour dom month dow"). Evaluated in
    // `timezone` (below) when set, else in the scheduler's server-local time.
    cron: text("cron").notNull(),
    // IANA timezone the cron is evaluated in ("America/New_York"). Null = server
    // local time (the pre-timezone behavior). Cloudflare-Scheduler parity: a
    // schedule's wall-clock intent is explicit, not tied to where the box runs.
    timezone: text("timezone"),
    prompt: text("prompt").notNull(),
    engine: text("engine").$type<EngineId>().notNull().default("mock"),
    model: text("model").notNull().default("claude-opus-5"),
    // Optional pinned skill/playbook revision for unattended runs. Mirrors the
    // run pin columns so scheduled execution carries the exact version/hash.
    skillId: text("skill_id"),
    skillVersion: integer("skill_version"),
    skillContentHash: text("skill_content_hash"),
    // Repository context and automation metadata are durable control-plane data.
    // They are not pasted into prompts; the run command receives repos as typed
    // execution context and tools return bounded summaries.
    repos: jsonb("repos").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    delivery: jsonb("delivery").$type<AutomationJson | null>(),
    notifications: jsonb("notifications").$type<AutomationJson | null>(),
    runActorId: text("run_actor_id"),
    concurrency: jsonb("concurrency").$type<AutomationJson | null>(),
    queue: jsonb("queue").$type<AutomationJson | null>(),
    costLimits: jsonb("cost_limits").$type<AutomationJson | null>(),
    frequencyLimits: jsonb("frequency_limits").$type<AutomationJson | null>(),
    approvalPolicy: jsonb("approval_policy").$type<AutomationJson | null>(),
    enablementPolicy: jsonb("enablement_policy").$type<AutomationJson | null>(),
    enabled: boolean("enabled").notNull().default(false),
    // Last time the loop fired this schedule. Used to de-dupe within a clock
    // minute (a 60s tick can revisit the same minute a cron matches).
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_schedules_org").on(t.orgId),
    index("idx_schedules_enabled").on(t.enabled),
  ],
);

// Append-only firing history — one row per fire, mirroring the event-sourced
// runs log (never mutated in place). `status` is the run's status snapshot at
// fire time ("queued"); the history reader joins `runs` for the live outcome.
export const scheduleFirings = pgTable(
  "schedule_firings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => schedules.id),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    // Deterministic per-occurrence key ("schedule:<id>:<minute-bucket>" for cron,
    // "schedule:<id>:manual:<ms>" for run-now). The SAME occurrence retried after
    // a crash reuses this key, so the UNIQUE index below makes recording a firing
    // idempotent — a retry never appends a duplicate row. Null on legacy rows
    // predating this column (nulls are distinct in a unique index, so they never
    // collide). The command lane carries the same key so ONE run is accepted per
    // occurrence; the firing row is its inspectable projection.
    idempotencyKey: text("idempotency_key"),
    firedAt: timestamp("fired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    trigger: text("trigger").$type<ScheduleTrigger>().notNull(),
    status: text("status").notNull(),
  },
  (t) => [
    index("idx_firings_schedule").on(t.scheduleId, t.firedAt),
    uniqueIndex("uq_firings_idem").on(t.idempotencyKey),
    // Run finalization resolves "was this run fired by an automation?" by run id
    // (Slack delivery of the terminal summary), so the lookup must be indexed.
    index("idx_firings_run").on(t.runId),
  ],
);

// ---------------------------------------------------------------------------
// Slash-command catalog cache. The engine's real command list (opencode's GET
// /command) is IDENTICAL for every fresh sandbox of a given snapshot, so it is
// cached ONCE per snapshot name rather than re-fetched per thread. The
// live-proxy upserts this row whenever a live sandbox answers /command; the New
// Task composer reads it (via GET /api/commands) to power "/" autocomplete
// BEFORE any sandbox exists. Single row per snapshot — a tiny keyed cache, not
// event-sourced state.
// ---------------------------------------------------------------------------

/** One entry in a command catalog, normalized across engines (opencode's /command
 *  and ACP's available_commands_update). `input` is an optional argument hint. Stored
 *  in jsonb, so the optional field is additive with NO migration. */
export interface CatalogCommand {
  name: string;
  description: string | null;
  input?: string | null;
}

export const commandsCatalog = pgTable("commands_catalog", {
  /** The Daytona snapshot the catalog was fetched from (DAYTONA_SNAPSHOT). */
  snapshot: text("snapshot").primaryKey(),
  commands: jsonb("commands")
    .$type<CatalogCommand[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

// Re-export the better-auth tables so drizzle-kit sees the whole schema and
// the drizzle adapter can resolve every model.
export * from "./auth-schema";
