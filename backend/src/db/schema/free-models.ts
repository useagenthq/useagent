import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
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

export const FREE_MODEL_CANDIDATE_STATES = [
  "pending",
  "qualified",
  "disqualified",
  "disabled",
] as const;
export type FreeModelCandidateState =
  (typeof FREE_MODEL_CANDIDATE_STATES)[number];

export const FREE_MODEL_PROBE_OUTCOMES = [
  "success",
  "failure",
  "system_failure",
] as const;
export type FreeModelProbeOutcome =
  (typeof FREE_MODEL_PROBE_OUTCOMES)[number];

export const FREE_MODEL_PROBE_ERROR_CODES = [
  "authentication_failed",
  "hosted_app_restricted",
  "invalid_response",
  "policy_rejected",
  "provider_capacity",
  "rate_limited",
  "timeout",
  "tool_call_failed",
  "transport_error",
  "unknown",
] as const;
export type FreeModelProbeErrorCode =
  (typeof FREE_MODEL_PROBE_ERROR_CODES)[number];

export const FREE_MODEL_PUBLISH_OUTCOMES = [
  "published",
  "preserved_empty",
  "preserved_system_failure",
] as const;
export type FreeModelPublishOutcome =
  (typeof FREE_MODEL_PUBLISH_OUTCOMES)[number];

export const freeModelCandidates = pgTable(
  "free_model_candidates",
  {
    modelId: text("model_id").primaryKey(),
    provider: text("provider").notNull(),
    source: text("source").notNull(),
    state: text("state")
      .$type<FreeModelCandidateState>()
      .notNull()
      .default("pending"),
    advertised: boolean("advertised").notNull().default(false),
    everQualified: boolean("ever_qualified").notNull().default(false),
    successStreak: integer("success_streak").notNull().default(0),
    failureStreak: integer("failure_streak").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextProbeAt: timestamp("next_probe_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    lastClaimedAt: timestamp("last_claimed_at", { withTimezone: true }),
    lastProbeAt: timestamp("last_probe_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    lastOutcome: text("last_outcome").$type<FreeModelProbeOutcome>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "free_model_candidates_state_check",
      sql`${t.state} IN ('pending', 'qualified', 'disqualified', 'disabled')`,
    ),
    check(
      "free_model_candidates_outcome_check",
      sql`${t.lastOutcome} IS NULL OR ${t.lastOutcome} IN ('success', 'failure', 'system_failure')`,
    ),
    check(
      "free_model_candidates_counter_check",
      sql`${t.successStreak} BETWEEN 0 AND 1000000 AND ${t.failureStreak} BETWEEN 0 AND 1000000 AND ${t.attemptCount} BETWEEN 0 AND 2147483647`,
    ),
    check(
      "free_model_candidates_claim_check",
      sql`(${t.claimToken} IS NULL AND ${t.claimExpiresAt} IS NULL) OR (${t.claimToken} IS NOT NULL AND ${t.claimExpiresAt} IS NOT NULL)`,
    ),
    index("idx_free_model_candidates_due")
      .on(t.nextProbeAt, t.modelId)
      .where(sql`${t.state} <> 'disabled'`),
    index("idx_free_model_candidates_claim_expiry").on(t.claimExpiresAt),
    index("idx_free_model_candidates_advertised").on(t.advertised, t.state),
  ],
);

export const freeModelProbeAttempts = pgTable(
  "free_model_probe_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    modelId: text("model_id").notNull(),
    claimToken: uuid("claim_token").notNull(),
    outcome: text("outcome").$type<FreeModelProbeOutcome>().notNull(),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms"),
    errorCode: text("error_code").$type<FreeModelProbeErrorCode>(),
    probedAt: timestamp("probed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "free_model_probe_attempts_outcome_check",
      sql`${t.outcome} IN ('success', 'failure', 'system_failure')`,
    ),
    check(
      "free_model_probe_attempts_http_status_check",
      sql`${t.httpStatus} IS NULL OR ${t.httpStatus} BETWEEN 100 AND 599`,
    ),
    check(
      "free_model_probe_attempts_latency_check",
      sql`${t.latencyMs} IS NULL OR ${t.latencyMs} BETWEEN 0 AND 3600000`,
    ),
    check(
      "free_model_probe_attempts_error_code_check",
      sql`${t.errorCode} IS NULL OR ${t.errorCode} IN ('authentication_failed', 'hosted_app_restricted', 'invalid_response', 'policy_rejected', 'provider_capacity', 'rate_limited', 'timeout', 'tool_call_failed', 'transport_error', 'unknown')`,
    ),
    foreignKey({
      name: "fk_free_model_probe_candidate",
      columns: [t.modelId],
      foreignColumns: [freeModelCandidates.modelId],
    }).onDelete("cascade"),
    uniqueIndex("uq_free_model_probe_attempts_claim").on(t.modelId, t.claimToken),
    index("idx_free_model_probe_attempts_model_time").on(t.modelId, t.probedAt),
  ],
);

export const freeModelRegistryState = pgTable(
  "free_model_registry_state",
  {
    lane: text("lane").primaryKey(),
    generation: bigint("generation", { mode: "number" }).notNull().default(1),
    currentModelIds: jsonb("current_model_ids").$type<string[]>().notNull(),
    lastGoodModelIds: jsonb("last_good_model_ids").$type<string[]>().notNull(),
    lastPublishOutcome: text("last_publish_outcome")
      .$type<FreeModelPublishOutcome>()
      .notNull()
      .default("published"),
    lastPublishAt: timestamp("last_publish_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    probeBudgetDay: date("probe_budget_day", { mode: "string" }).notNull(),
    dailyProbeBudget: integer("daily_probe_budget").notNull().default(24),
    probesClaimedToday: integer("probes_claimed_today").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "free_model_registry_state_publish_outcome_check",
      sql`${t.lastPublishOutcome} IN ('published', 'preserved_empty', 'preserved_system_failure')`,
    ),
    check(
      "free_model_registry_state_generation_check",
      sql`${t.generation} >= 1`,
    ),
    check(
      "free_model_registry_state_model_ids_check",
      sql`jsonb_typeof(${t.currentModelIds}) = 'array' AND jsonb_typeof(${t.lastGoodModelIds}) = 'array'`,
    ),
    check(
      "free_model_registry_state_budget_check",
      sql`${t.dailyProbeBudget} BETWEEN 1 AND 10000 AND ${t.probesClaimedToday} BETWEEN 0 AND ${t.dailyProbeBudget}`,
    ),
  ],
);

export type FreeModelCandidateRow = typeof freeModelCandidates.$inferSelect;
export type FreeModelProbeAttemptRow = typeof freeModelProbeAttempts.$inferSelect;
export type FreeModelRegistryStateRow = typeof freeModelRegistryState.$inferSelect;
