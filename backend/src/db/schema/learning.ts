import { type MemoryScope } from "@useagent/agent-client/wire";
import { sql } from "drizzle-orm";
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
import { skills, type SkillSections } from "./skills";

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
