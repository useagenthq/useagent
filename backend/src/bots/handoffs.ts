import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { botHandle } from "@useagent/agent-client";
import { db, type Executor } from "../db/client";
import {
  botHandoffs,
  bots,
  runs,
  threadRelationships,
  type BotRow,
} from "../db/schema";
import { acceptRunCancel } from "../commands/cancel";
import { findCommandByKey } from "../commands/repo";
import { CHILD_PROMPT_MAX_CHARS } from "../runs/child-session-policy";
import { pumpProductChildThread } from "../runs/child-session-pump";
import {
  createChildSession,
  productChildCommandKey,
} from "../runs/child-sessions";
import { acceptThreadFollowup } from "../runs/thread-followups";
import { getThreadRelationship } from "../runs/thread-relationship-repo";
import { defaultModelForEngine } from "../runs/model-policy";
import { productChildThreadsEnabled } from "../runs/thread-relationship-rollout";
import { botsEnabled } from "./rollout";
import { BOT_HANDOFF_RUN_ORIGIN } from "../runs/origin";
import {
  claimBotHandoffAttempt,
  HandoffLockTimeout,
  withBotHandoffLocks,
} from "./handoff-admission";
import { followupHandoffKey, mentionHandoffKey } from "./handoff-keys";

export { mentionHandoffKey } from "./handoff-keys";

/** Bots one message (or one turn through the gateway tool) may hand work to. */
export const MENTIONS_MAX = 5;
/** A thread may hand work to a bot only while its own delegation depth is below this. */
export const MAX_HANDOFF_DEPTH = 2;
/** Delegated threads one parent thread may open, and one thread family may hold, in total. */
export const MAX_HANDOFFS_PER_PARENT = 5;
export const MAX_HANDOFFS_PER_FAMILY = 20;
/** New delegated threads one bot may receive per hour, across the org, split by who asked:
 *  unattended sources (routine firings, automations, other bots) are the
 *  loop shape and get the tight cap; people get room for legitimate fan-in. Neither cap
 *  counts follow-ups into existing threads, and the per-parent and per-family caps still apply. */
export const MAX_UNATTENDED_HANDOFFS_PER_BOT_PER_HOUR = 10;
export const MAX_ATTENDED_HANDOFFS_PER_BOT_PER_HOUR = 120;
const HOUR_MS = 60 * 60 * 1000;
/** Retries when another writer wins the child thread's head between read and accept. */
const HEAD_RACE_RETRIES = 5;
const HEAD_RACE_BACKOFF_MS = 25;
const ANCESTOR_WALK_LIMIT = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function retryHandoffHeadRace<
  T extends { readonly status: string },
>(
  attempt: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<unknown> = Bun.sleep,
): Promise<T> {
  let outcome = await attempt();
  for (
    let retry = 1;
    outcome.status === "stale_parent" && retry < HEAD_RACE_RETRIES;
    retry += 1
  ) {
    await sleep(Math.min(400, HEAD_RACE_BACKOFF_MS * 2 ** (retry - 1)));
    outcome = await attempt();
  }
  return outcome;
}

/** `bot_mentions` on a run body: up to five bot ids, deduplicated. */
export function parseBotMentions(
  value: unknown,
): { ids: string[] } | { error: string } {
  if (value === undefined || value === null) return { ids: [] };
  if (!Array.isArray(value))
    return { error: "bot_mentions must be an array of bot ids" };
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !UUID.test(entry))
      return { error: "bot_mentions must be bot ids" };
    ids.add(entry.toLowerCase());
  }
  if (ids.size > MENTIONS_MAX)
    return { error: `at most ${MENTIONS_MAX} bots per message` };
  return { ids: [...ids] };
}

export type RunBotMentions =
  | { readonly ids: string[] }
  | { readonly status: 400 | 404; readonly body: Record<string, unknown> };

/** Validate `bot_mentions` for a run body before anything is persisted. */
export function runBotMentions(orgId: string, value: unknown): RunBotMentions {
  const parsed = parseBotMentions(value);
  if ("error" in parsed)
    return {
      status: 400,
      body: { error: "invalid_bot_mentions", reason: parsed.error },
    };
  if (parsed.ids.length > 0 && !botsEnabled(orgId))
    return { status: 404, body: { error: "bots_disabled" } };
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
    const handoffs = await dispatchBotHandoffs({
      ...input,
      parentRunId: input.runId,
    });
    return handoffs.length > 0 ? { handoffs } : {};
  } catch (error) {
    // The parent run is accepted; the caller still learns that no bot got the work.
    console.error(
      `[bots] handoff dispatch failed for run ${input.runId}:`,
      error,
    );
    const message = error instanceof Error ? error.message : String(error);
    return {
      handoffs: input.botIds.map((botId) => ({
        botId,
        name: "",
        threadId: null,
        status: "failed" as const,
        error: message,
      })),
    };
  }
}

/**
 * A delegated turn's prompt is the message that addressed the bot, nothing
 * else: identity and standing rules reach the model as turn context (see
 * prompt-context.ts). The child inherits the parent thread's repositories and
 * resources through the child-session path.
 */
function boundedHandoffText(text: string): string {
  const clean = text.trim();
  if (clean.length <= CHILD_PROMPT_MAX_CHARS) return clean;
  return `${clean.slice(0, CHILD_PROMPT_MAX_CHARS - 40).trimEnd()}\n\n[message truncated for the handoff]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "<bot>: <ask>", with the bot's own @mention token (its name or its handle,
 *  see `botHandle`) removed so the title does not name it twice. */
function handoffTitle(name: string, text: string): string {
  const handles = [...new Set([name, botHandle(name)])].filter(Boolean).map(escapeRegExp);
  const token = new RegExp(`@bot/(?:${handles.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const ask = text.replace(token, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return ask ? `${name}: ${ask}` : name;
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
  readonly status:
    | "created"
    | "replayed"
    | "followed_up"
    | "refused"
    | "busy"
    | "conflict"
    | "not_found"
    | "unavailable"
    | "failed";
  readonly reason?: HandoffRefusal;
  /** For `refused`/`cap`: when the hourly window frees up, if that is what refused it. */
  readonly retryAfterMs?: number;
  /** For `failed`: why dispatch threw (prompt too large, queue ceiling, ...). */
  readonly error?: string;
}

export type HandoffRefusal = "self" | "cycle" | "depth" | "cap";

/** The bot that owns a thread: its home thread, or a delegated thread handed to it. */
export async function botOwningThread(
  orgId: string,
  threadId: string,
): Promise<BotRow | null> {
  const [home] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.orgId, orgId), eq(bots.homeThreadId, threadId)))
    .limit(1);
  if (home) return home;
  const [handed] = await db
    .select({ bot: bots })
    .from(botHandoffs)
    .innerJoin(
      bots,
      and(eq(bots.orgId, botHandoffs.orgId), eq(bots.id, botHandoffs.botId)),
    )
    .where(
      and(eq(botHandoffs.orgId, orgId), eq(botHandoffs.threadId, threadId)),
    )
    .limit(1);
  return handed?.bot ?? null;
}

/** The delegation chain above a thread, nearest parent first, bounded. Every delegated
 *  ancestor counts, bot-owned or not: a plain product child two levels down cannot
 *  reach a bot either, by design (depth is about cost and attention, not identity). */
export async function threadAncestors(
  orgId: string,
  threadId: string,
): Promise<{ readonly threadIds: string[]; readonly familyThreadId: string }> {
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
export async function handoffRefusal(
  orgId: string,
  bot: Pick<BotRow, "id" | "homeThreadId">,
  threadId: string,
): Promise<HandoffRefusal | null> {
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

/** Why opening one more delegated thread under `threadId`, for `botId`, is refused, or null. */
async function handoffCapReached(
  orgId: string,
  threadId: string,
  botId: string,
  sourceRunId: string,
): Promise<{ readonly retryAfterMs?: number } | null> {
  const [source] = await db
    .select({ origin: runs.origin })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.id, sourceRunId)))
    .limit(1);
  if (!source) throw new Error("bot handoff source run is unavailable");
  // Origin is trusted execution provenance. Routines intentionally retain the
  // creator's user id, so user_id cannot distinguish them from live people.
  const unattended = source.origin != null;
  const [window] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${botHandoffs.createdAt})`,
    })
    .from(botHandoffs)
    .innerJoin(
      runs,
      and(
        eq(runs.orgId, botHandoffs.orgId),
        eq(runs.id, botHandoffs.sourceRunId),
      ),
    )
    .where(
      and(
        eq(botHandoffs.orgId, orgId),
        eq(botHandoffs.botId, botId),
        sql`${botHandoffs.createdAt} > now() - interval '1 hour'`,
        unattended
          ? sql`${runs.origin} is not null`
          : sql`${runs.origin} is null`,
      ),
    );
  const hourlyCap = unattended
    ? MAX_UNATTENDED_HANDOFFS_PER_BOT_PER_HOUR
    : MAX_ATTENDED_HANDOFFS_PER_BOT_PER_HOUR;
  if ((window?.count ?? 0) >= hourlyCap) {
    const oldest = window?.oldest
      ? new Date(window.oldest).getTime()
      : Date.now();
    return { retryAfterMs: Math.max(60_000, oldest + HOUR_MS - Date.now()) };
  }
  const [perParent] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(botHandoffs)
    .where(
      and(
        eq(botHandoffs.orgId, orgId),
        eq(botHandoffs.parentThreadId, threadId),
      ),
    );
  if ((perParent?.count ?? 0) >= MAX_HANDOFFS_PER_PARENT) return {};
  const { familyThreadId } = await threadAncestors(orgId, threadId);
  const [perFamily] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(botHandoffs)
    .innerJoin(
      threadRelationships,
      and(
        eq(threadRelationships.orgId, botHandoffs.orgId),
        eq(threadRelationships.threadId, botHandoffs.threadId),
      ),
    )
    .where(
      and(
        eq(botHandoffs.orgId, orgId),
        eq(threadRelationships.familyThreadId, familyThreadId),
      ),
    );
  return (perFamily?.count ?? 0) >= MAX_HANDOFFS_PER_FAMILY ? {} : null;
}

/** The bot's most recent delegated thread under this parent thread, if any. */
export async function findOpenHandoffThread(
  orgId: string,
  botId: string,
  parentThreadId: string,
): Promise<string | null> {
  return findOpenHandoffThreadWith(db, orgId, botId, parentThreadId);
}

async function findOpenHandoffThreadWith(
  exec: Executor,
  orgId: string,
  botId: string,
  parentThreadId: string,
): Promise<string | null> {
  const [row] = await exec
    .select({ threadId: botHandoffs.threadId })
    .from(botHandoffs)
    .where(
      and(
        eq(botHandoffs.orgId, orgId),
        eq(botHandoffs.botId, botId),
        eq(botHandoffs.parentThreadId, parentThreadId),
      ),
    )
    .orderBy(asc(botHandoffs.createdAt), asc(botHandoffs.threadId))
    .limit(1);
  return row?.threadId ?? null;
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
  const createInput = {
    orgId: input.orgId,
    actorId: input.actorId,
    parentRunId: input.parentRunId,
    threadId: input.threadId,
    prompt: boundedHandoffText(input.text),
    title: input.title || handoffTitle(bot.name, input.text),
    engine: bot.engine,
    model: bot.model ?? defaultModelForEngine(bot.engine),
    repos: [...bot.repos],
    memoryScope: bot.memoryScope,
    idempotencyKey: input.idempotencyKey,
    origin: BOT_HANDOFF_RUN_ORIGIN,
  } as const;

  const { familyThreadId } = await threadAncestors(input.orgId, input.threadId);
  try {
    return await withBotHandoffLocks(
      [
        `bot-handoff-bot:${input.orgId}:${bot.id}`,
        `bot-handoff-family:${input.orgId}:${familyThreadId}`,
        `bot-handoff-run:${input.orgId}:${input.parentRunId}`,
      ],
      async () => {
        if (
          !(await claimBotHandoffAttempt({
            orgId: input.orgId,
            actorId: input.actorId,
            parentRunId: input.parentRunId,
            threadId: input.threadId,
            botId: bot.id,
            maxAttempts: MENTIONS_MAX,
          }))
        ) {
          return {
            botId: bot.id,
            name: bot.name,
            threadId: null,
            status: "refused",
            reason: "cap",
          };
        }
        const refusal = await handoffRefusal(input.orgId, bot, input.threadId);
        if (refusal)
          return {
            botId: bot.id,
            name: bot.name,
            threadId: null,
            status: "refused",
            reason: refusal,
          };

        // A retry with the same key replays the child it created, read from the command
        // row itself: recomposing the prompt would turn a bot rules edit in between into a
        // false conflict, and the model would then retry under a new key.
        const creationKey = productChildCommandKey(
          input.threadId,
          input.parentRunId,
          input.idempotencyKey,
        );
        const created = await findCommandByKey(input.orgId, creationKey);
        if (created?.threadId)
          return {
            botId: bot.id,
            name: bot.name,
            threadId: created.threadId,
            status: "replayed",
          };

        // A message that mentioned the bot already handed it off at run create; the same
        // turn's bot_handoff call for that bot must replay, not hand the identical ask again.
        // Distinct tool calls in one turn (different keys, no mention) stay distinct follow-ups.
        const mentionKey = mentionHandoffKey(input.parentRunId, bot.id);
        if (input.idempotencyKey !== mentionKey) {
          const handedByMention = await findOpenHandoffThreadWith(
            db,
            input.orgId,
            bot.id,
            input.threadId,
          );
          if (
            handedByMention &&
            ((await findCommandByKey(
              input.orgId,
              productChildCommandKey(
                input.threadId,
                input.parentRunId,
                mentionKey,
              ),
            )) ||
              (await findCommandByKey(
                input.orgId,
                followupHandoffKey(input.threadId, bot.id, mentionKey),
              )))
          ) {
            return {
              botId: bot.id,
              name: bot.name,
              threadId: handedByMention,
              status: "replayed",
            };
          }
        }
        const existing = await findOpenHandoffThreadWith(
          db,
          input.orgId,
          bot.id,
          input.threadId,
        );
        if (existing) {
          const followup = await retryHandoffHeadRace(() =>
            acceptThreadFollowup({
              orgId: input.orgId,
              actorId: input.actorId,
              threadId: existing,
              text: boundedHandoffText(input.text),
              attachmentIds: [],
              idempotencyKey: followupHandoffKey(
                input.threadId,
                bot.id,
                input.idempotencyKey,
              ),
            }),
          );
          if (followup.status === "created" || followup.status === "replayed") {
            if (followup.status === "created") {
              await pumpProductChildThread(existing).catch((error) => {
                console.error(
                  `[bots] handoff follow-up pump failed for ${existing}:`,
                  error,
                );
              });
            }
            return {
              botId: bot.id,
              name: bot.name,
              threadId: existing,
              status:
                followup.status === "created" ? "followed_up" : "replayed",
            };
          }
          if (followup.status === "conflict")
            return {
              botId: bot.id,
              name: bot.name,
              threadId: null,
              status: "conflict",
            };
          if (
            await findOpenHandoffThreadWith(
              db,
              input.orgId,
              bot.id,
              input.threadId,
            )
          ) {
            return {
              botId: bot.id,
              name: bot.name,
              threadId: existing,
              status: "busy",
            };
          }
        }

        const capped = await handoffCapReached(
          input.orgId,
          input.threadId,
          bot.id,
          input.parentRunId,
        );
        if (capped) {
          return {
            botId: bot.id,
            name: bot.name,
            threadId: null,
            status: "refused",
            reason: "cap",
            ...(capped.retryAfterMs
              ? { retryAfterMs: capped.retryAfterMs }
              : {}),
          };
        }

        const outcome = await createChildSession(createInput);
        if (outcome.status === "conflict")
          return {
            botId: bot.id,
            name: bot.name,
            threadId: null,
            status: "conflict",
          };
        const threadId = await recordBotHandoff(
          {
            orgId: input.orgId,
            botId: bot.id,
            threadId: outcome.child.id,
            parentThreadId: input.threadId,
            sourceRunId: input.parentRunId,
          },
          db,
        );
        return {
          botId: bot.id,
          name: bot.name,
          threadId,
          status: threadId === outcome.child.id ? outcome.status : "replayed",
        };
      },
    );
  } catch (error) {
    if (error instanceof HandoffLockTimeout)
      return { botId: bot.id, name: bot.name, threadId: null, status: "busy" };
    throw error;
  }
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
    return input.botIds.map((botId) => ({
      botId,
      name: "",
      threadId: null,
      status: "unavailable" as const,
    }));
  }
  const rows = await db
    .select()
    .from(bots)
    .where(
      and(
        eq(bots.orgId, input.orgId),
        inArray(bots.id, [...input.botIds]),
        eq(bots.archived, false),
      ),
    );
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
        idempotencyKey: mentionHandoffKey(input.parentRunId, bot.id),
      }),
    );
  }
  return results;
}

/** Bots a run has already handed work to (through mentions or the gateway tool). */
export async function distinctBotsHandedOffByRun(
  orgId: string,
  runId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ botId: botHandoffs.botId })
    .from(botHandoffs)
    .where(
      and(eq(botHandoffs.orgId, orgId), eq(botHandoffs.sourceRunId, runId)),
    );
  return new Set(rows.map((row) => row.botId));
}

/** Attribute a delegated child thread to a bot; idempotent per thread. */
export async function recordBotHandoff(
  row: {
    readonly orgId: string;
    readonly botId: string;
    readonly threadId: string;
    readonly parentThreadId: string;
    readonly sourceRunId: string;
  },
  exec: Executor = db,
): Promise<string> {
  const [inserted] = await exec
    .insert(botHandoffs)
    .values(row)
    .onConflictDoNothing()
    .returning({ threadId: botHandoffs.threadId });
  if (inserted) return inserted.threadId;
  const winner = await findOpenHandoffThreadWith(
    exec,
    row.orgId,
    row.botId,
    row.parentThreadId,
  );
  if (winner && winner !== row.threadId) {
    // Under the per-(org, bot, parent) lock this cannot happen; if it does, the child just
    // created would run the ask unattributed. Stop it and make the redirect visible.
    console.error(
      `[bots] handoff attribution for bot ${row.botId} under ${row.parentThreadId} already points at ${winner}; cancelling orphan child ${row.threadId}`,
    );
    await acceptRunCancel({
      orgId: row.orgId,
      actorId: null,
      runId: row.threadId,
    }).catch((error) => {
      console.error(
        `[bots] could not cancel orphan handoff child ${row.threadId}:`,
        error,
      );
    });
  }
  if (!winner)
    throw new Error("bot handoff attribution conflict could not be recovered");
  return winner;
}

/** Resolve an @mention typed by an agent: a bot id, a case-insensitive name,
 *  or the name's handle (`@bot/night-triage` for "Night triage"). */
export async function resolveBotMention(
  orgId: string,
  raw: string,
): Promise<BotRow | null> {
  const needle = raw.trim().replace(/^@?(bot\/)?/i, "");
  if (!needle) return null;
  if (UUID.test(needle)) {
    const [row] = await db
      .select()
      .from(bots)
      .where(
        and(
          eq(bots.orgId, orgId),
          eq(bots.id, needle.toLowerCase()),
          eq(bots.archived, false),
        ),
      )
      .limit(1);
    return row ?? null;
  }
  const rows = await db
    .select()
    .from(bots)
    .where(and(eq(bots.orgId, orgId), eq(bots.archived, false)));
  const name = needle.toLowerCase();
  const handle = botHandle(needle);
  return (
    rows.find((row) => row.name.toLowerCase() === name) ??
    (handle ? rows.find((row) => botHandle(row.name) === handle) : undefined) ??
    null
  );
}
