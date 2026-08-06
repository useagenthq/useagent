import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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

/** Which harness executes a run. `mock` is the scripted trace; the user-facing
 *  engines (opencode / claude / codex) ALL execute inside a per-thread Daytona
 *  cloud sandbox (src/engines/sandbox.ts). `daytona` and `claude-sdk` are legacy
 *  ids kept so pre-consolidation rows still resolve (aliased in the registry);
 *  `acp` is the ACP bridge (registered, hidden from the UI). This list is THE
 *  accepted set at every API boundary (runs, schedules, Slack default). */
export const ENGINE_IDS = [
  "mock",
  "opencode",
  "claude",
  "codex",
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
    // each "owner/name", validated against GET /api/repos. jsonb string[]; empty
    // = a bare workdir; inherited across a thread. `repo` above is the legacy
    // single-value mirror (repos[0] ?? null), kept for back-compat, deprecated.
    repos: jsonb("repos").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
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
// Slack adapter — maps a Slack thread to the skynet run that ROOTED it, so a
// later reply in that Slack thread becomes a `parent_run_id` follow-up (shared
// thread, clean prompts). One row per Slack thread the bot has engaged; the
// composite key is the Slack thread's identity `(channel, thread root ts)`.
// ---------------------------------------------------------------------------

export const slackThreads = pgTable(
  "slack_threads",
  {
    channel: text("channel").notNull(),
    threadTs: text("thread_ts").notNull(),
    rootRunId: text("root_run_id")
      .notNull()
      .references(() => runs.id),
    orgId: text("org_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channel, t.threadTs] })],
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
export type SlackOutboxKind = "post_message" | "add_reaction";
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
// Schedules — unattended autonomy. A schedule fires the existing run-creation
// path on a 5-field cron expression (the always-on 60s scheduler loop) or on a
// manual "run now". `enabled` defaults FALSE — reference bot's safety default, so an
// imported/created schedule never auto-fires until a human turns it on.
// ---------------------------------------------------------------------------

/** How a firing was triggered: the cron loop, or a manual "run now". */
export type ScheduleTrigger = "cron" | "manual";

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

/** One entry in a snapshot's slash-command catalog (opencode's /command shape,
 *  normalized). */
export interface CatalogCommand {
  name: string;
  description: string | null;
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
