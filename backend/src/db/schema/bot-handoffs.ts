import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bots } from "./bots";
import { runs } from "./runs";

/**
 * A handoff is a child thread opened for a bot by an @mention, from a person
 * in any thread or from another bot through the gateway. The thread is an
 * ordinary delegated product child (thread_relationships); this row is what
 * attributes it to the bot so the roster can show work that did not start in
 * the bot's home thread.
 */
export const botHandoffs = pgTable(
  "bot_handoffs",
  {
    orgId: text("org_id").notNull(),
    botId: uuid("bot_id").notNull(),
    threadId: text("thread_id").notNull(),
    parentThreadId: text("parent_thread_id").notNull(),
    sourceRunId: text("source_run_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "bot_handoffs_org_thread_pk",
      columns: [t.orgId, t.threadId],
    }),
    uniqueIndex("uq_bot_handoffs_parent_bot").on(
      t.orgId,
      t.botId,
      t.parentThreadId,
    ),
    index("idx_bot_handoffs_bot").on(t.orgId, t.botId, t.createdAt),
    foreignKey({
      name: "fk_bot_handoffs_bot",
      columns: [t.botId],
      foreignColumns: [bots.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "fk_bot_handoffs_thread",
      columns: [t.orgId, t.threadId],
      foreignColumns: [runs.orgId, runs.id],
    }).onDelete("cascade"),
  ],
);

export type BotHandoffRow = typeof botHandoffs.$inferSelect;
