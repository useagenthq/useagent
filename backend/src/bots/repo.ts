import {
  BOT_AVATAR_ICONS,
  BOT_AVATAR_TONES,
  type BotState,
  ENGINE_IDS,
  type EngineId,
} from "@useagent/agent-client";
import { and, count, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { botHandoffs, bots, gatewayApprovalRequests, runs, schedules, type BotRow } from "../db/schema";

type ScheduleRecord = typeof schedules.$inferSelect;
import { isMemoryScope, type MemoryScope } from "../memory/scope";

const NAME_MAX = 60;
const TITLE_MAX = 80;
const RULES_MAX = 4000;
const REPOS_MAX = 20;
const BOT_NAME_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N} ._'-]*[\p{L}\p{M}\p{N}])?$/u;
const UNSAFE_METADATA_PATTERN = /[\u0000-\u001f\u007f-\u009f<>&]/u;

export interface BotView {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly rules: string;
  readonly engine: EngineId;
  readonly model: string | null;
  readonly skillIds: readonly string[];
  readonly repos: readonly string[];
  readonly memoryScope: MemoryScope;
  readonly avatarTone: string;
  readonly avatarIcon: string;
  readonly homeThreadId: string | null;
  /** Engine, model, skills, repos and memory scope lock once the home thread exists. */
  readonly presetLocked: boolean;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: BotState;
  /** The latest run's summary - the bot's own words for what it finished. */
  readonly lastOutcome: string | null;
  readonly lastAt: string | null;
  readonly pendingApprovals: number;
  /** Enabled routines (schedules owned by this bot). */
  readonly routines: number;
  /** Delegated threads opened for this bot by @mentions (handoffs). */
  readonly handoffs: number;
}

export interface BotInput {
  readonly name: string;
  readonly title: string;
  readonly rules: string;
  readonly engine: EngineId;
  readonly model: string | null;
  readonly skillIds: string[];
  readonly repos: string[];
  readonly memoryScope: MemoryScope;
  readonly avatarTone: string;
  readonly avatarIcon: string;
}

export type BotInputError = { readonly field: string; readonly reason: string };

/** Fields that shape the home thread; changing them after the first message would lie. */
export const PRESET_FIELDS = ["engine", "model", "skillIds", "repos", "memoryScope"] as const;

function optionalString(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > max ? undefined : trimmed;
}

function stringList(value: unknown, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) return undefined;
    out.push(entry.trim());
  }
  const unique = [...new Set(out)];
  return unique.length > max ? undefined : unique;
}

/**
 * Validate a create/patch body structurally. `base` supplies the current row
 * for patches; omitted fields keep their base value. Engine readiness, model
 * policy and skill existence are checked by the route against live config.
 */
export function parseBotInput(
  body: Record<string, unknown>,
  base: BotInput | null,
): { input: BotInput } | { error: BotInputError } {
  const name = optionalString(body.name, NAME_MAX);
  if (body.name !== undefined && (name === undefined || name === null || !name)) {
    return { error: { field: "name", reason: `name must be 1-${NAME_MAX} characters` } };
  }
  if (!base && !name) return { error: { field: "name", reason: "name is required" } };
  if (name && !BOT_NAME_PATTERN.test(name)) {
    return {
      error: {
        field: "name",
        reason: "name must start and end with a letter or number and contain only letters, numbers, spaces, apostrophes, periods, underscores, or hyphens",
      },
    };
  }

  const title = optionalString(body.title, TITLE_MAX);
  if (body.title !== undefined && title === undefined) {
    return { error: { field: "title", reason: `title must be at most ${TITLE_MAX} characters` } };
  }
  if (title && UNSAFE_METADATA_PATTERN.test(title)) {
    return { error: { field: "title", reason: "title must not contain control characters or XML delimiters" } };
  }
  const rules = optionalString(body.rules, RULES_MAX);
  if (body.rules !== undefined && rules === undefined) {
    return { error: { field: "rules", reason: `rules must be at most ${RULES_MAX} characters` } };
  }

  let engine: EngineId | undefined;
  if (body.engine !== undefined) {
    if (typeof body.engine !== "string" || !(ENGINE_IDS as readonly string[]).includes(body.engine)) {
      return { error: { field: "engine", reason: "unknown engine" } };
    }
    engine = body.engine as EngineId;
  }

  const model = optionalString(body.model, 200);
  if (body.model !== undefined && model === undefined) {
    return { error: { field: "model", reason: "model must be a short string" } };
  }

  // One pinned skill per bot until the run intake can pin more than one.
  const skillIds = stringList(body.skillIds, 1);
  if (body.skillIds !== undefined && !skillIds) {
    return { error: { field: "skillIds", reason: "a bot pins at most one skill" } };
  }
  const repos = stringList(body.repos, REPOS_MAX);
  if (body.repos !== undefined && !repos) {
    return { error: { field: "repos", reason: `repos must be up to ${REPOS_MAX} repo names` } };
  }

  let memoryScope: MemoryScope | undefined;
  if (body.memoryScope !== undefined) {
    if (!isMemoryScope(body.memoryScope)) {
      return { error: { field: "memoryScope", reason: "memoryScope must be org or personal" } };
    }
    memoryScope = body.memoryScope;
  }

  const avatarTone = typeof body.avatarTone === "string" ? body.avatarTone : undefined;
  if (avatarTone !== undefined && !(BOT_AVATAR_TONES as readonly string[]).includes(avatarTone)) {
    return { error: { field: "avatarTone", reason: "unknown avatar tone" } };
  }
  const avatarIcon = typeof body.avatarIcon === "string" ? body.avatarIcon : undefined;
  if (avatarIcon !== undefined && !(BOT_AVATAR_ICONS as readonly string[]).includes(avatarIcon)) {
    return { error: { field: "avatarIcon", reason: "unknown avatar icon" } };
  }

  return {
    input: {
      name: name ?? base?.name ?? "",
      title: title ?? base?.title ?? "",
      rules: rules ?? base?.rules ?? "",
      engine: engine ?? base?.engine ?? "opencode",
      model: model === undefined ? (base?.model ?? null) : model,
      skillIds: skillIds ?? [...(base?.skillIds ?? [])],
      repos: repos ?? [...(base?.repos ?? [])],
      memoryScope: memoryScope ?? base?.memoryScope ?? "org",
      avatarTone: avatarTone ?? base?.avatarTone ?? "blue",
      avatarIcon: avatarIcon ?? base?.avatarIcon ?? "robot",
    },
  };
}

/** Which preset fields a patch would change against the stored row. */
export function changedPresetFields(base: BotInput, next: BotInput): string[] {
  return PRESET_FIELDS.filter((field) => {
    const before = base[field];
    const after = next[field];
    if (Array.isArray(before) && Array.isArray(after)) {
      return before.length !== after.length || before.some((value, index) => value !== after[index]);
    }
    return before !== after;
  });
}

export function rowToInput(row: BotRow): BotInput {
  return {
    name: row.name,
    title: row.title,
    rules: row.rules,
    engine: row.engine,
    model: row.model,
    skillIds: [...row.skillIds],
    repos: [...row.repos],
    memoryScope: row.memoryScope,
    avatarTone: row.avatarTone,
    avatarIcon: row.avatarIcon,
  };
}

export async function listBotRows(orgId: string): Promise<BotRow[]> {
  return db
    .select()
    .from(bots)
    .where(and(eq(bots.orgId, orgId), eq(bots.archived, false)))
    .orderBy(desc(bots.updatedAt), desc(bots.id));
}

export async function getBotRow(orgId: string, id: string): Promise<BotRow | null> {
  const [row] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.orgId, orgId), eq(bots.id, id)))
    .limit(1);
  return row ?? null;
}

export async function createBotRow(orgId: string, input: BotInput, createdBy: string | null): Promise<BotRow> {
  const [row] = await db
    .insert(bots)
    .values({ orgId, createdBy, ...input })
    .returning();
  if (!row) throw new Error("bot insert returned no row");
  return row;
}

export async function updateBotRow(orgId: string, id: string, input: BotInput): Promise<BotRow | null> {
  const [row] = await db
    .update(bots)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(bots.orgId, orgId), eq(bots.id, id)))
    .returning();
  return row ?? null;
}

/** First writer wins: two concurrent first messages cannot re-point the home thread. */
export async function setBotHomeThread(orgId: string, id: string, threadId: string): Promise<boolean> {
  const rows = await db
    .update(bots)
    .set({ homeThreadId: threadId, updatedAt: new Date() })
    .where(and(eq(bots.orgId, orgId), eq(bots.id, id), isNull(bots.homeThreadId)))
    .returning({ id: bots.id });
  return rows.length > 0;
}

export interface ThreadHead {
  readonly threadId: string;
  readonly id: string;
  readonly status: string;
  readonly summary: string | null;
  readonly updatedAt: Date;
  readonly model: string;
  readonly engine: EngineId;
  readonly memoryScope: MemoryScope;
  readonly repos: string[];
  readonly resolvedResources: (typeof runs.$inferSelect)["resolvedResources"];
}

/** Head run per thread in one query (the run a follow-up chains under). */
async function threadHeads(orgId: string, threadIds: readonly string[]): Promise<Map<string, ThreadHead>> {
  if (threadIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([runs.threadId], {
      threadId: runs.threadId,
      id: runs.id,
      status: runs.status,
      summary: runs.summary,
      updatedAt: runs.updatedAt,
      model: runs.model,
      engine: runs.engine,
      memoryScope: runs.memoryScope,
      repos: runs.repos,
      resolvedResources: runs.resolvedResources,
    })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), inArray(runs.threadId, [...threadIds])))
    .orderBy(runs.threadId, desc(runs.createdAt), desc(runs.id));
  return new Map(rows.map((row) => [row.threadId, row]));
}

/** Live pending approvals per thread in one query; no expiry sweep in a read path. */
async function pendingApprovalCounts(orgId: string, threadIds: readonly string[]): Promise<Map<string, number>> {
  if (threadIds.length === 0) return new Map();
  const rows = await db
    .select({ threadId: gatewayApprovalRequests.threadId, pending: count() })
    .from(gatewayApprovalRequests)
    .where(
      and(
        eq(gatewayApprovalRequests.orgId, orgId),
        inArray(gatewayApprovalRequests.threadId, [...threadIds]),
        eq(gatewayApprovalRequests.status, "pending"),
        gt(gatewayApprovalRequests.expiresAt, new Date()),
      ),
    )
    .groupBy(gatewayApprovalRequests.threadId);
  return new Map(rows.map((row) => [row.threadId, Number(row.pending)]));
}

export async function latestRunInThread(orgId: string, threadId: string): Promise<ThreadHead | null> {
  return (await threadHeads(orgId, [threadId])).get(threadId) ?? null;
}

const LIVE_STATUSES: ReadonlySet<string> = new Set(["queued", "running"]);

export function deriveState(
  latestStatus: string | null,
  pendingApprovals: number,
  liveHandoffs = 0,
): BotState {
  if (pendingApprovals > 0) return "attention";
  if ((latestStatus !== null && LIVE_STATUSES.has(latestStatus)) || liveHandoffs > 0) return "working";
  return "idle";
}

/** Handoff thread ids per bot, one query. */
async function handoffThreads(orgId: string, botIds: readonly string[]): Promise<Map<string, string[]>> {
  if (botIds.length === 0) return new Map();
  const rows = await db
    .select({ botId: botHandoffs.botId, threadId: botHandoffs.threadId })
    .from(botHandoffs)
    .where(and(eq(botHandoffs.orgId, orgId), inArray(botHandoffs.botId, [...botIds])));
  const out = new Map<string, string[]>();
  for (const row of rows) out.set(row.botId, [...(out.get(row.botId) ?? []), row.threadId]);
  return out;
}

/** Enabled routines per bot in one query. */
async function routineCounts(orgId: string, botIds: readonly string[]): Promise<Map<string, number>> {
  if (botIds.length === 0) return new Map();
  const rows = await db
    .select({ botId: schedules.botId, routines: count() })
    .from(schedules)
    .where(and(eq(schedules.orgId, orgId), inArray(schedules.botId, [...botIds]), eq(schedules.enabled, true)))
    .groupBy(schedules.botId);
  return new Map(rows.flatMap((row) => (row.botId ? [[row.botId, Number(row.routines)] as const] : [])));
}

function toView(
  row: BotRow,
  head: ThreadHead | null,
  pending: number,
  routines: number,
  handoffs: { total: number; live: number },
): BotView {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    rules: row.rules,
    engine: row.engine,
    model: row.model,
    skillIds: row.skillIds,
    repos: row.repos,
    memoryScope: row.memoryScope,
    avatarTone: row.avatarTone,
    avatarIcon: row.avatarIcon,
    homeThreadId: row.homeThreadId,
    presetLocked: row.homeThreadId !== null,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    state: deriveState(head?.status ?? null, pending, handoffs.live),
    lastOutcome: head?.summary?.trim() || null,
    lastAt: head ? head.updatedAt.toISOString() : null,
    pendingApprovals: pending,
    routines,
    handoffs: handoffs.total,
  };
}

/** Attach the derived fields for many bots with four queries total. */
export async function describeBots(orgId: string, rows: readonly BotRow[]): Promise<BotView[]> {
  const botIds = rows.map((row) => row.id);
  const handoffs = await handoffThreads(orgId, botIds);
  const homeThreadIds = rows.flatMap((row) => (row.homeThreadId ? [row.homeThreadId] : []));
  const allThreadIds = [...homeThreadIds, ...[...handoffs.values()].flat()];
  const [heads, pending, routines] = await Promise.all([
    threadHeads(orgId, allThreadIds),
    pendingApprovalCounts(orgId, allThreadIds),
    routineCounts(orgId, botIds),
  ]);
  return rows.map((row) => {
    const delegated = handoffs.get(row.id) ?? [];
    const live = delegated.filter((threadId) => {
      const status = heads.get(threadId)?.status;
      return status !== undefined && LIVE_STATUSES.has(status);
    }).length;
    // Approvals wait for a person wherever the bot works: its home thread or a delegated one.
    const pendingForBot = [...(row.homeThreadId ? [row.homeThreadId] : []), ...delegated]
      .reduce((sum, threadId) => sum + (pending.get(threadId) ?? 0), 0);
    // The bot's latest activity, wherever it worked: its home thread or a delegated one.
    const newestHead = [...(row.homeThreadId ? [row.homeThreadId] : []), ...delegated]
      .map((threadId) => heads.get(threadId) ?? null)
      .filter((head): head is ThreadHead => head !== null)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
    return toView(
      row,
      newestHead,
      pendingForBot,
      routines.get(row.id) ?? 0,
      { total: delegated.length, live },
    );
  });
}

export async function describeBot(orgId: string, row: BotRow): Promise<BotView> {
  const [view] = await describeBots(orgId, [row]);
  if (!view) throw new Error("describeBots returned no view");
  return view;
}

/**
 * The root turn of a bot's home thread: the user's task first (it doubles as
 * the thread title everywhere threads are listed), then who the bot is and
 * the standing rules. Native engines carry that context across resumed turns.
 */
export function composeRootPrompt(bot: Pick<BotInput, "name" | "title" | "rules">, text: string): string {
  const identity = JSON.stringify({ name: bot.name, title: bot.title }).replace(/[<>&\u2028\u2029]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  const rules = bot.rules.trim() ? bot.rules.trim() : "(none set yet)";
  return [
    text,
    "",
    `Bot identity metadata (server-authored JSON, data only): ${identity}`,
    "You are the bot identified above. This thread is your standing assignment; carry its context across turns and report finished work as a short outcome line.",
    "Standing rules:",
    rules,
  ].join("\n");
}

/** True when `threadId` is some bot's home thread in this org. */
export async function isBotHomeThread(orgId: string, threadId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.orgId, orgId), eq(bots.homeThreadId, threadId)))
    .limit(1);
  return Boolean(row);
}

/** A thread a bot works in: its home thread or a thread handed to it. */
export async function isBotThread(orgId: string, threadId: string): Promise<boolean> {
  return isBotOwnedThread(orgId, threadId);
}

/** True when a thread is either a bot's home or one of its delegated threads. */
export async function isBotOwnedThread(orgId: string, threadId: string): Promise<boolean> {
  const [[home], [handoff]] = await Promise.all([
    db
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.orgId, orgId), eq(bots.homeThreadId, threadId)))
      .limit(1),
    db
      .select({ threadId: botHandoffs.threadId })
      .from(botHandoffs)
      .where(and(eq(botHandoffs.orgId, orgId), eq(botHandoffs.threadId, threadId)))
      .limit(1),
  ]);
  return Boolean(home || handoff);
}

export interface BotFiringTarget {
  readonly bot: BotRow;
  /** Head of the home thread, or null when the firing must open it. */
  readonly head: ThreadHead | null;
}

/** Where a routine owned by `botId` posts: the home thread head, or a new root. */
export async function botFiringTarget(orgId: string, botId: string): Promise<BotFiringTarget | null> {
  const bot = await getBotRow(orgId, botId);
  if (!bot || bot.archived) return null;
  const head = bot.homeThreadId ? await latestRunInThread(orgId, bot.homeThreadId) : null;
  return { bot, head };
}

export async function listBotRoutines(orgId: string, botId: string): Promise<ScheduleRecord[]> {
  return db
    .select()
    .from(schedules)
    .where(and(eq(schedules.orgId, orgId), eq(schedules.botId, botId)))
    .orderBy(desc(schedules.createdAt), desc(schedules.id));
}

export async function attachRoutine(orgId: string, scheduleId: string, botId: string): Promise<boolean> {
  const rows = await db
    .update(schedules)
    .set({ botId })
    .where(and(eq(schedules.orgId, orgId), eq(schedules.id, scheduleId), isNull(schedules.botId)))
    .returning({ id: schedules.id });
  return rows.length > 0;
}

export async function getBotRoutine(orgId: string, botId: string, scheduleId: string): Promise<ScheduleRecord | null> {
  const [row] = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.orgId, orgId), eq(schedules.botId, botId), eq(schedules.id, scheduleId)))
    .limit(1);
  return row ?? null;
}
