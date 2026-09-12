import type { EngineId } from "@useagent/agent-client";
import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { MemoryScope } from "../../memory/scope";
import { runs } from "./runs";

/**
 * A bot is a named preset over one durable home thread: engine, model, skills,
 * repos, memory scope, and standing rules. Status, last outcome, and pending
 * approvals are never stored here - they derive from the runs in the home
 * thread, so the roster can never drift from the event log.
 */
export const bots = pgTable(
  "bots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    title: text("title").notNull().default(""),
    rules: text("rules").notNull().default(""),
    engine: text("engine").$type<EngineId>().notNull().default("opencode"),
    model: text("model"),
    skillIds: jsonb("skill_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    repos: jsonb("repos").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    memoryScope: text("memory_scope").$type<MemoryScope>().notNull().default("org"),
    avatarTone: text("avatar_tone").notNull().default("blue"),
    avatarIcon: text("avatar_icon").notNull().default("robot"),
    /** Root run id of the bot's DM thread; null until the first message. */
    homeThreadId: text("home_thread_id"),
    createdBy: text("created_by"),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_bots_org_name").on(t.orgId, t.name),
    index("idx_bots_org_active").on(t.orgId, t.archived, t.updatedAt),
    foreignKey({
      name: "fk_bots_home_thread",
      columns: [t.orgId, t.homeThreadId],
      foreignColumns: [runs.orgId, runs.id],
    }).onDelete("set null"),
  ],
);

export type BotRow = typeof bots.$inferSelect;
export type NewBotRow = typeof bots.$inferInsert;
