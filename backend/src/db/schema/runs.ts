import {
  ENGINE_IDS,
  MEMORY_SCOPES,
  type EngineId,
  type MemoryScope,
  type RunStatus,
  type StepKind,
} from "@useagent/agent-client/wire";
import type { RunResource } from "../../resources/types";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
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

// ---------------------------------------------------------------------------
// Shared domain types — the run/step wire enums live in the agent-client wire
// contract (packages never import apps, so the ground truth is the package). The
// column `.$type<>()` annotations below consume them; re-exported here so the
// many backend modules that read them from `../db/schema` keep one import path.
// ---------------------------------------------------------------------------

export { ENGINE_IDS, MEMORY_SCOPES };
export type { EngineId, MemoryScope, RunStatus, StepKind };

// ---------------------------------------------------------------------------
// Runs + steps — the durable event log (ARCHITECTURE.md step 1), now on
// Postgres. `org_id` / `user_id` are nullable so legacy/system runs still fit.
// ---------------------------------------------------------------------------

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id"),
    // Authoritative project identity. Null is a supported independent thread.
    // Repo strings below remain compatibility and clone metadata.
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
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
    // native conversation EXPLICITLY by id — a peer tool's set_resume_session_id
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
    // Immutable terminal timestamp. Unlike updated_at, sandbox cleanup and
    // metadata maintenance must never rewrite historical settlement metrics.
    settledAt: timestamp("settled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_runs_created").on(t.createdAt),
    index("idx_runs_org").on(t.orgId),
    index("idx_runs_org_project_created").on(t.orgId, t.projectId, t.createdAt, t.id),
    index("idx_runs_thread").on(t.threadId),
    index("idx_runs_org_created").on(t.orgId, t.createdAt, t.id),
    index("idx_runs_org_settled").on(t.orgId, t.settledAt, t.id),
    index("idx_runs_org_parent_created").on(t.orgId, t.parentRunId, t.createdAt, t.id),
    index("idx_runs_org_thread_created").on(t.orgId, t.threadId, t.createdAt, t.id),
    uniqueIndex("uq_runs_org_id").on(t.orgId, t.id),
    uniqueIndex("uq_runs_finished_work_scope").on(t.orgId, t.id, t.threadId),
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
