import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { botHandoffs, bots, type BotRow } from "../db/schema";
import { pumpProductChildThread } from "../runs/child-session-pump";
import { createChildSession } from "../runs/child-sessions";
import { acceptThreadFollowup } from "../runs/thread-followups";
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

export type RunBotMentions =
  | { readonly ids: string[] }
  | { readonly status: 400 | 404; readonly body: Record<string, unknown> };

/** Validate `bot_mentions` for a run body before anything is persisted. */
export function runBotMentions(orgId: string, value: unknown): RunBotMentions {
  const parsed = parseBotMentions(value);
  if ("error" in parsed) return { status: 400, body: { error: "invalid_bot_mentions", reason: parsed.error } };
  if (parsed.ids.length > 0 && !botsEnabled(orgId)) return { status: 404, body: { error: "bots_disabled" } };
  return parsed;
}

/**
 * Response fragment for an accepted run: `{ handoffs }` when bots were
 * mentioned, `{}` otherwise. The parent run is already durable; a handoff
 * failure is logged and reported, never fatal to the accepted run.
 */
export async function acceptedRunHandoffs(input: {
  readonly orgId: string;
  readonly actorId: string | null;
  readonly runId: string;
  readonly threadId: string;
  readonly text: string;
  readonly botIds: readonly string[];
}): Promise<{ handoffs?: HandoffResult[] }> {
  if (input.botIds.length === 0) return {};
  try {
    const handoffs = await dispatchBotHandoffs({ ...input, parentRunId: input.runId });
    return handoffs.length > 0 ? { handoffs } : {};
  } catch (error) {
    console.error(`[bots] handoff dispatch failed for run ${input.runId}:`, error);
    return {};
  }
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
    "If the message is a question, answer it. If it names no task, say what you can do from your standing rules and skills instead of waiting.",
    "Standing rules:",
    rules,
  ].join("\n");
}

export interface HandoffResult {
  readonly botId: string;
  readonly name: string;
  readonly threadId: string | null;
  /** `followed_up`: the bot already has a delegated thread under this parent
   *  thread, so the message became its next turn instead of a second thread.
   *  `unavailable`: product child threads are off for this org, so a handoff
   *  would degrade to a deferred turn on the parent's engine - refused instead. */
  readonly status: "created" | "replayed" | "followed_up" | "conflict" | "not_found" | "unavailable";
}

/** The bot's most recent delegated thread under this parent thread, if any. */
export async function findOpenHandoffThread(orgId: string, botId: string, parentThreadId: string): Promise<string | null> {
  const [row] = await db
    .select({ threadId: botHandoffs.threadId })
    .from(botHandoffs)
    .where(and(eq(botHandoffs.orgId, orgId), eq(botHandoffs.botId, botId), eq(botHandoffs.parentThreadId, parentThreadId)))
    .orderBy(desc(botHandoffs.createdAt))
    .limit(1);
  return row?.threadId ?? null;
}

/** A follow-up into the bot's existing delegated thread: the ask, plus where it came from. */
export function composeHandoffFollowup(bot: Pick<BotRow, "name">, text: string): string {
  return `${text}\n\n(Handed to you, ${bot.name}, from the same thread as before; continue there and end with a short outcome line.)`;
}

/**
 * Hand one message to one bot. The first mention under a parent thread opens
 * the bot's delegated child thread; every later mention from that thread
 * becomes the next turn of the same child, so a conversation with a bot stays
 * one thread instead of one thread per message.
 */
export async function handoffToBot(input: {
  readonly orgId: string;
  readonly actorId: string | null;
  readonly parentRunId: string;
  readonly threadId: string;
  readonly bot: BotRow;
  readonly text: string;
  readonly title?: string;
  readonly idempotencyKey: string;
}): Promise<HandoffResult> {
  const { bot } = input;
  const existing = await findOpenHandoffThread(input.orgId, bot.id, input.threadId);
  if (existing) {
    const followup = await acceptThreadFollowup({
      orgId: input.orgId,
      actorId: input.actorId,
      threadId: existing,
      text: composeHandoffFollowup(bot, input.text),
      attachmentIds: [],
      idempotencyKey: input.idempotencyKey,
    });
    if (followup.status === "created" || followup.status === "replayed") {
      if (followup.status === "created") {
        await pumpProductChildThread(existing).catch((error) => {
          console.error(`[bots] handoff follow-up pump failed for ${existing}:`, error);
        });
      }
      return { botId: bot.id, name: bot.name, threadId: existing, status: "followed_up" };
    }
    if (followup.status === "conflict") return { botId: bot.id, name: bot.name, threadId: null, status: "conflict" };
    // not_found / stale_parent: the old thread is gone; open a fresh one below.
  }
  const outcome = await createChildSession({
    orgId: input.orgId,
    actorId: input.actorId,
    parentRunId: input.parentRunId,
    threadId: input.threadId,
    prompt: composeHandoffPrompt(bot, input.text),
    title: input.title || `${bot.name}: ${input.text.replace(/\s+/g, " ").slice(0, 120)}`,
    engine: bot.engine,
    model: bot.model ?? defaultModelForEngine(bot.engine),
    repos: [...bot.repos],
    memoryScope: bot.memoryScope,
    idempotencyKey: input.idempotencyKey,
  });
  if (outcome.status === "conflict") return { botId: bot.id, name: bot.name, threadId: null, status: "conflict" };
  await recordBotHandoff({
    orgId: input.orgId,
    botId: bot.id,
    threadId: outcome.child.id,
    parentThreadId: input.threadId,
    sourceRunId: input.parentRunId,
  });
  return { botId: bot.id, name: bot.name, threadId: outcome.child.id, status: outcome.status };
}

/** Handoffs are real only as independently messageable product child threads. */
export function handoffsAvailable(orgId: string | null): boolean {
  return botsEnabled(orgId) && productChildThreadsEnabled(orgId);
}

/**
 * Hand the message to each mentioned bot on the bot's own preset (engine,
 * model, memory scope) - the cross-harness handoff. One delegated thread per
 * (parent thread, bot), reused across messages; idempotent per (parent run,
 * bot). Missing or archived bots are reported, never fatal.
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
    results.push(
      await handoffToBot({
        orgId: input.orgId,
        actorId: input.actorId,
        parentRunId: input.parentRunId,
        threadId: input.threadId,
        bot,
        text: input.text,
        idempotencyKey: `bot-handoff:${input.parentRunId}:${bot.id}`,
      }),
    );
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
