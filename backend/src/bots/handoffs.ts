import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { botHandoffs, bots, type BotRow } from "../db/schema";
import { createChildSession } from "../runs/child-sessions";
import { defaultModelForEngine } from "../runs/model-policy";
import { productChildThreadsEnabled } from "../runs/thread-relationship-rollout";
import { botsEnabled } from "./rollout";

const MENTIONS_MAX = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `bot_mentions` on a run body: up to five bot ids, deduplicated. */
export function parseBotMentions(value: unknown): { ids: string[] } | { error: string } {
  if (value === undefined || value === null) return { ids: [] };
  if (!Array.isArray(value)) return { error: "bot_mentions must be an array of bot ids" };
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !UUID.test(entry)) return { error: "bot_mentions must be bot ids" };
    ids.add(entry.toLowerCase());
  }
  if (ids.size > MENTIONS_MAX) return { error: `at most ${MENTIONS_MAX} bots per message` };
  return { ids: [...ids] };
}

/**
 * The child thread's first turn: the message that addressed the bot, then who
 * the bot is and its standing rules. The child inherits the parent thread's
 * repositories and resources through the child-session path.
 */
export function composeHandoffPrompt(bot: Pick<BotRow, "name" | "title" | "rules">, text: string): string {
  const who = bot.title ? `${bot.name}, ${bot.title}` : bot.name;
  const rules = bot.rules.trim() ? bot.rules.trim() : "(none set yet)";
  return [
    text,
    "",
    `You are ${who}. This thread was handed to you from another thread; do the part addressed to you and end with a short outcome line for whoever handed it over.`,
    "Standing rules:",
    rules,
  ].join("\n");
}

export interface HandoffResult {
  readonly botId: string;
  readonly name: string;
  readonly threadId: string | null;
  /** `unavailable`: product child threads are off for this org, so a handoff
   *  would degrade to a deferred turn on the parent's engine - refused instead. */
  readonly status: "created" | "replayed" | "conflict" | "not_found" | "unavailable";
}

/** Handoffs are real only as independently messageable product child threads. */
export function handoffsAvailable(orgId: string | null): boolean {
  return botsEnabled(orgId) && productChildThreadsEnabled(orgId);
}

/**
 * Open one delegated child thread per mentioned bot, on the bot's own preset
 * (engine, model, memory scope) - the cross-harness handoff. Idempotent per
 * (parent run, bot). Missing or archived bots are reported, never fatal.
 */
export async function dispatchBotHandoffs(input: {
  readonly orgId: string;
  readonly actorId: string | null;
  readonly parentRunId: string;
  readonly threadId: string;
  readonly text: string;
  readonly botIds: readonly string[];
}): Promise<HandoffResult[]> {
  if (input.botIds.length === 0 || !botsEnabled(input.orgId)) return [];
  if (!productChildThreadsEnabled(input.orgId)) {
    return input.botIds.map((botId) => ({ botId, name: "", threadId: null, status: "unavailable" as const }));
  }
  const rows = await db
    .select()
    .from(bots)
    .where(and(eq(bots.orgId, input.orgId), inArray(bots.id, [...input.botIds]), eq(bots.archived, false)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const results: HandoffResult[] = [];
  for (const botId of input.botIds) {
    const bot = byId.get(botId);
    if (!bot) {
      results.push({ botId, name: "", threadId: null, status: "not_found" });
      continue;
    }
    const outcome = await createChildSession({
      orgId: input.orgId,
      actorId: input.actorId,
      parentRunId: input.parentRunId,
      threadId: input.threadId,
      prompt: composeHandoffPrompt(bot, input.text),
      title: `${bot.name}: ${input.text.replace(/\s+/g, " ").slice(0, 120)}`,
      engine: bot.engine,
      model: bot.model ?? defaultModelForEngine(bot.engine),
      repos: [...bot.repos],
      memoryScope: bot.memoryScope,
      idempotencyKey: `bot-handoff:${input.parentRunId}:${bot.id}`,
    });
    if (outcome.status === "conflict") {
      results.push({ botId, name: bot.name, threadId: null, status: "conflict" });
      continue;
    }
    await recordBotHandoff({
      orgId: input.orgId,
      botId: bot.id,
      threadId: outcome.child.id,
      parentThreadId: input.threadId,
      sourceRunId: input.parentRunId,
    });
    results.push({ botId, name: bot.name, threadId: outcome.child.id, status: outcome.status });
  }
  return results;
}

/** Attribute a delegated child thread to a bot; idempotent per thread. */
export async function recordBotHandoff(row: {
  readonly orgId: string;
  readonly botId: string;
  readonly threadId: string;
  readonly parentThreadId: string;
  readonly sourceRunId: string;
}): Promise<void> {
  await db.insert(botHandoffs).values(row).onConflictDoNothing();
}

/** Resolve an @mention typed by an agent: a bot id, or a case-insensitive name. */
export async function resolveBotMention(orgId: string, raw: string): Promise<BotRow | null> {
  const needle = raw.trim().replace(/^@?(bot\/)?/i, "");
  if (!needle) return null;
  if (UUID.test(needle)) {
    const [row] = await db.select().from(bots).where(and(eq(bots.orgId, orgId), eq(bots.id, needle.toLowerCase()), eq(bots.archived, false))).limit(1);
    return row ?? null;
  }
  const [row] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.orgId, orgId), eq(bots.archived, false), sql`lower(${bots.name}) = lower(${needle})`))
    .limit(1);
  return row ?? null;
}
