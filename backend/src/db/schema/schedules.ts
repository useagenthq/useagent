import { type EngineId } from "@useagent/agent-client/wire";
import { sql } from "drizzle-orm";
import {
  boolean,
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
    index("idx_schedules_org_created").on(t.orgId, t.createdAt, t.id),
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
