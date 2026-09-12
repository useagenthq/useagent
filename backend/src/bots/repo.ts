import { ENGINE_IDS, type EngineId } from "@useagent/agent-client";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { bots, runs, type BotRow } from "../db/schema";
import { listPendingApprovalRequests } from "../knowledge/gateway/approval-requests";
import { isMemoryScope, type MemoryScope } from "../memory/scope";

export const BOT_AVATAR_TONES = [
  "blue",
  "violet",
  "emerald",
  "amber",
  "rose",
  "cyan",
  "fuchsia",
  "slate",
] as const;
export const BOT_AVATAR_ICONS = [
  "robot",
  "code",
  "research",
  "chart",
  "megaphone",
  "sales",
  "support",
  "pen",
  "compass",
] as const;

const NAME_MAX = 60;
const TITLE_MAX = 80;
const RULES_MAX = 4000;
const LIST_MAX = 20;

/** Derived, never stored: what the roster shows beside the name. */
export type BotState = "attention" | "working" | "idle";

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
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: BotState;
  /** The latest run's summary - the bot's own words for what it finished. */
  readonly lastOutcome: string | null;
  readonly lastAt: string | null;
  readonly pendingApprovals: number;
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

function optionalString(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > max ? undefined : trimmed;
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) return undefined;
    out.push(entry.trim());
  }
  return out.length > LIST_MAX ? undefined : [...new Set(out)];
}

/**
 * Validate a create/patch body. `base` supplies the current row for patches;
 * omitted fields keep their base value. Returns the first error found.
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

  const title = optionalString(body.title, TITLE_MAX);
  if (body.title !== undefined && title === undefined) {
    return { error: { field: "title", reason: `title must be at most ${TITLE_MAX} characters` } };
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

  const skillIds = stringList(body.skillIds);
  if (body.skillIds !== undefined && !skillIds) {
    return { error: { field: "skillIds", reason: `skillIds must be up to ${LIST_MAX} ids` } };
  }
  const repos = stringList(body.repos);
  if (body.repos !== undefined && !repos) {
    return { error: { field: "repos", reason: `repos must be up to ${LIST_MAX} repo names` } };
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

export async function createBotRow(
  orgId: string,
  input: BotInput,
  createdBy: string | null,
): Promise<BotRow> {
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

export async function setBotHomeThread(orgId: string, id: string, threadId: string): Promise<void> {
  await db
    .update(bots)
    .set({ homeThreadId: threadId, updatedAt: new Date() })
    .where(and(eq(bots.orgId, orgId), eq(bots.id, id)));
}

/** Head of the home thread: the run a follow-up must chain under. */
export async function latestRunInThread(
  orgId: string,
  threadId: string,
): Promise<{ id: string; status: string; summary: string | null; updatedAt: Date } | null> {
  const [row] = await db
    .select({ id: runs.id, status: runs.status, summary: runs.summary, updatedAt: runs.updatedAt })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.threadId, threadId)))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return row ?? null;
}

export function deriveState(
  latestStatus: string | null,
  pendingApprovals: number,
): BotState {
  if (pendingApprovals > 0) return "attention";
  if (latestStatus === "queued" || latestStatus === "running") return "working";
  return "idle";
}

/** Attach the derived fields; one thread lookup + one approvals lookup per bot. */
export async function describeBot(orgId: string, row: BotRow): Promise<BotView> {
  const latest = row.homeThreadId ? await latestRunInThread(orgId, row.homeThreadId) : null;
  const pending = row.homeThreadId
    ? (await listPendingApprovalRequests({ orgId, threadId: row.homeThreadId })).length
    : 0;
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
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    state: deriveState(latest?.status ?? null, pending),
    lastOutcome: latest?.summary?.trim() || null,
    lastAt: latest ? latest.updatedAt.toISOString() : null,
    pendingApprovals: pending,
  };
}

export async function describeBots(orgId: string, rows: readonly BotRow[]): Promise<BotView[]> {
  return Promise.all(rows.map((row) => describeBot(orgId, row)));
}

/**
 * The root turn of a bot's home thread carries its identity and standing rules
 * once; native engines keep that context across resumed turns, so later
 * messages can be plain text.
 */
export function composeRootPrompt(bot: Pick<BotInput, "name" | "title" | "rules">, text: string): string {
  const who = bot.title ? `${bot.name}, ${bot.title}` : bot.name;
  const rules = bot.rules.trim() ? bot.rules.trim() : "(none set yet)";
  return [
    `You are ${who}. This thread is your standing assignment; carry its context across turns and report finished work as a short outcome line.`,
    "Standing rules:",
    rules,
    "",
    text,
  ].join("\n");
}
