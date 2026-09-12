import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { botHandoffs, bots, type BotRow } from "../db/schema";
import { findCommandByKey } from "../commands/repo";
import { CHILD_PROMPT_MAX_CHARS } from "../runs/child-session-policy";
import { threadRelationships } from "../db/schema";
import { pumpProductChildThread } from "../runs/child-session-pump";
import { createChildSession, productChildCommandKey } from "../runs/child-sessions";
import { acceptThreadFollowup } from "../runs/thread-followups";
import { getThreadRelationship } from "../runs/thread-relationship-repo";
import { defaultModelForEngine } from "../runs/model-policy";
import { productChildThreadsEnabled } from "../runs/thread-relationship-rollout";
import { botsEnabled } from "./rollout";

/** Bots one message (or one turn through the gateway tool) may hand work to. */
export const MENTIONS_MAX = 5;
/** A thread may hand work to a bot only while its own delegation depth is below this. */
export const MAX_HANDOFF_DEPTH = 2;
/** Delegated threads one parent thread may open, and one thread family may hold, in total. */
export const MAX_HANDOFFS_PER_PARENT = 5;
export const MAX_HANDOFFS_PER_FAMILY = 20;
/** Retries when another writer wins the child thread's head between read and accept. */
const HEAD_RACE_RETRIES = 3;
const ANCESTOR_WALK_LIMIT = 16;
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
    // The parent run is accepted; the caller still learns that no bot got the work.
    console.error(`[bots] handoff dispatch failed for run ${input.runId}:`, error);
    const message = error instanceof Error ? error.message : String(error);
    return { handoffs: input.botIds.map((botId) => ({ botId, name: "", threadId: null, status: "failed" as const, error: message })) };
  }
}

/**
 * The child thread's first turn: the message that addressed the bot, then who
 * the bot is and its standing rules. The child inherits the parent thread's
 * repositories and resources through the child-session path.
 */
function boundedHandoffText(text: string): string {
  const clean = text.trim();
  if (clean.length <= CHILD_PROMPT_MAX_CHARS) return clean;
  return `${clean.slice(0, CHILD_PROMPT_MAX_CHARS - 40).trimEnd()}\n\n[message truncated for the handoff]`;
}

export function composeHandoffPrompt(bot: Pick<BotRow, "name" | "title" | "rules">, text: string): string {
  const who = bot.title ? `${bot.name}, ${bot.title}` : bot.name;
  const rules = bot.rules.trim() ? bot.rules.trim() : "(none set yet)";
  return [
    boundedHandoffText(text),
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
   *  `refused`: a structural guard said no (see `reason`); `busy`: the child's
   *  head kept moving under the follow-up, try again later.
   *  `unavailable`: product child threads are off for this org, so a handoff
   *  would degrade to a deferred turn on the parent's engine - refused instead. */
  readonly status: "created" | "replayed" | "followed_up" | "refused" | "busy" | "conflict" | "not_found" | "unavailable" | "failed";
  readonly reason?: HandoffRefusal;
  /** For `failed`: why dispatch threw (prompt too large, queue ceiling, ...). */
  readonly error?: string;
}

export type HandoffRefusal = "self" | "cycle" | "depth" | "cap";

/** The bot that owns a thread: its home thread, or a delegated thread handed to it. */
export async function botOwningThread(orgId: string, threadId: string): Promise<BotRow | null> {
  const [home] = await db.select().from(bots).where(and(eq(bots.orgId, orgId), eq(bots.homeThreadId, threadId))).limit(1);
  if (home) return home;
  const [handed] = await db
    .select({ bot: bots })
    .from(botHandoffs)
    .innerJoin(bots, and(eq(bots.orgId, botHandoffs.orgId), eq(bots.id, botHandoffs.botId)))
    .where(and(eq(botHandoffs.orgId, orgId), eq(botHandoffs.threadId, threadId)))
    .limit(1);
  return handed?.bot ?? null;
}

/** The delegation chain above a thread, nearest parent first, bounded. */
export async function threadAncestors(orgId: string, threadId: string): Promise<{ readonly threadIds: string[]; readonly familyThreadId: string }> {
  const threadIds: string[] = [];
  let current = threadId;
  let family = threadId;
  for (let hop = 0; hop < ANCESTOR_WALK_LIMIT; hop += 1) {
    const rel = await getThreadRelationship(orgId, current);
    if (!rel) break;
    family = rel.familyThreadId;
    if (!rel.parentThreadId) break;
    threadIds.push(rel.parentThreadId);
    current = rel.parentThreadId;
  }
  return { threadIds, familyThreadId: family };
}

/**
 * Why a thread may not hand work to a bot: it is the bot's own thread (self),
 * the bot already sits above this thread in the chain (A -> B -> A), or the
 * chain is already as deep as delegation goes. Structural, not prompt-level:
 * a bot that is told to delegate to itself must be refused here.
 */
export async function handoffRefusal(orgId: string, bot: Pick<BotRow, "id" | "homeThreadId">, threadId: string): Promise<HandoffRefusal | null> {
  const owner = await botOwningThread(orgId, threadId);
  if (owner?.id === bot.id) return "self";
  const { threadIds } = await threadAncestors(orgId, threadId);
  for (const ancestor of threadIds) {
    const above = await botOwningThread(orgId, ancestor);
    if (above?.id === bot.id) return "cycle";
  }
  if (threadIds.length >= MAX_HANDOFF_DEPTH) return "depth";
  return null;
}

/** Whether opening one more delegated thread under `threadId` would exceed the caps. */
async function handoffCapReached(orgId: string, threadId: string): Promise<boolean> {
  const [perParent] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(botHandoffs)
    .where(and(eq(botHandoffs.orgId, orgId), eq(botHandoffs.parentThreadId, threadId)));
  if ((perParent?.count ?? 0) >= MAX_HANDOFFS_PER_PARENT) return true;
  const { familyThreadId } = await threadAncestors(orgId, threadId);
  const [perFamily] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(botHandoffs)
    .innerJoin(threadRelationships, and(eq(threadRelationships.orgId, botHandoffs.orgId), eq(threadRelationships.threadId, botHandoffs.threadId)))
    .where(and(eq(botHandoffs.orgId, orgId), eq(threadRelationships.familyThreadId, familyThreadId)));
  return (perFamily?.count ?? 0) >= MAX_HANDOFFS_PER_FAMILY;
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
export function composeHandoffFollowup(bot: Pick<BotRow, "name" | "title">, text: string): string {
  const who = bot.title ? `${bot.name}, ${bot.title}` : bot.name;
  return `${boundedHandoffText(text)}\n\n(Handed to you again from the same thread. You are still ${who}; your standing rules apply. Continue here and end with a short outcome line.)`;
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
  const refusal = await handoffRefusal(input.orgId, bot, input.threadId);
  if (refusal) return { botId: bot.id, name: bot.name, threadId: null, status: "refused", reason: refusal };
  // A retry with the same key after the child was created must replay, never append a turn.
  const created = await findCommandByKey(input.orgId, productChildCommandKey(input.threadId, input.parentRunId, input.idempotencyKey));
  if (created?.threadId) return { botId: bot.id, name: bot.name, threadId: created.threadId, status: "replayed" };
  // The bot's delegated thread under this parent is continued even after a failed turn: the
  // follow-up is the retry, in context. A fresh thread would fail the same way and lose history.
  const existing = await findOpenHandoffThread(input.orgId, bot.id, input.threadId);
  if (existing) {
    for (let attempt = 0; attempt < HEAD_RACE_RETRIES; attempt += 1) {
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
      if (followup.status === "not_found") break; // the delegated thread is gone: open a fresh one below
      // stale_parent: another writer moved the child's head; re-read and try again, never fork
    }
    if (await findOpenHandoffThread(input.orgId, bot.id, input.threadId)) {
      return { botId: bot.id, name: bot.name, threadId: existing, status: "busy" };
    }
  }
  if (await handoffCapReached(input.orgId, input.threadId)) {
    return { botId: bot.id, name: bot.name, threadId: null, status: "refused", reason: "cap" };
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
  try {
    await recordBotHandoff({
      orgId: input.orgId,
      botId: bot.id,
      threadId: outcome.child.id,
      parentThreadId: input.threadId,
      sourceRunId: input.parentRunId,
    });
  } catch (error) {
    // The child exists and runs; without this row the next mention opens another. Loud, not fatal.
    console.error(`[bots] handoff attribution failed for thread ${outcome.child.id} (bot ${bot.id}):`, error);
  }
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

/** Bots a run has already handed work to (through mentions or the gateway tool). */
export async function distinctBotsHandedOffByRun(orgId: string, runId: string): Promise<Set<string>> {
  const rows = await db
    .select({ botId: botHandoffs.botId })
    .from(botHandoffs)
    .where(and(eq(botHandoffs.orgId, orgId), eq(botHandoffs.sourceRunId, runId)));
  return new Set(rows.map((row) => row.botId));
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
