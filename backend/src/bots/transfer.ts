import type { BotRow, schedules } from "../db/schema";
import { assertRunPromptLimit, RunPromptTooLargeError } from "../commands/prompt-policy";
import { isValidCron, isValidTimezone } from "../schedules/cron";
import { type BotInput, type BotInputError, parseBotInput } from "./repo";

type ScheduleRecord = typeof schedules.$inferSelect;

/**
 * A bot as a file: what one person exports from a bot's details and another
 * imports into their own workspace. It carries only what the bot is (name,
 * look, rules, engine, model, repositories, memory scope) and its routines
 * (when and what). Never ids, people, thread history or anything secret: a
 * bot holds no secret, and every id names something in the old workspace
 * (its pinned skill included, so the file leaves the skill out).
 */
export const BOT_FILE_FORMAT = "useagent.bot";
export const BOT_FILE_VERSION = 1;
/** Routines one file may bring; each becomes an automation of the importer. */
export const BOT_FILE_ROUTINES_MAX = 20;

/** The bot fields a file carries, in the order a person reads them. */
const BOT_FIELDS = ["name", "title", "rules", "engine", "model", "repos", "memoryScope", "avatarTone", "avatarIcon"] as const;

export interface BotFileRoutine {
  readonly name: string;
  readonly cron: string;
  readonly timezone: string;
  readonly prompt: string;
}

export interface BotFile {
  readonly format: typeof BOT_FILE_FORMAT;
  readonly version: typeof BOT_FILE_VERSION;
  readonly bot: {
    readonly name: string;
    readonly title: string;
    readonly rules: string;
    readonly engine: string;
    readonly model: string | null;
    readonly repos: readonly string[];
    readonly memoryScope: string;
    readonly avatarTone: string;
    readonly avatarIcon: string;
  };
  readonly routines: readonly BotFileRoutine[];
}

/** The file for one bot and its routines, oldest routine first. */
export function botFile(row: BotRow, routines: readonly ScheduleRecord[]): BotFile {
  return {
    format: BOT_FILE_FORMAT,
    version: BOT_FILE_VERSION,
    bot: {
      name: row.name,
      title: row.title,
      rules: row.rules,
      engine: row.engine,
      model: row.model,
      repos: [...row.repos],
      memoryScope: row.memoryScope,
      avatarTone: row.avatarTone,
      avatarIcon: row.avatarIcon,
    },
    routines: [...routines]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((routine) => ({ name: routine.name, cron: routine.cron, timezone: routine.timezone, prompt: routine.prompt })),
  };
}

export interface ParsedBotFile {
  readonly input: BotInput;
  readonly routines: readonly BotFileRoutine[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function fail(field: string, reason: string): { error: BotInputError } {
  return { error: { field, reason } };
}

function parseRoutine(value: unknown, index: number): BotFileRoutine | { error: BotInputError } {
  const at = `routines[${index}]`;
  if (!isRecord(value)) return fail(at, `${at} must be an object`);
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string).trim() : "");
  const name = text("name");
  if (!name) return fail(`${at}.name`, "every routine needs a name");
  const cron = text("cron");
  if (!isValidCron(cron)) return fail(`${at}.cron`, `${name} needs a valid 5-field cron schedule`);
  const timezone = value.timezone === undefined || value.timezone === null || value.timezone === "" ? "UTC" : text("timezone");
  if (!isValidTimezone(timezone)) return fail(`${at}.timezone`, `${name} names an unknown time zone`);
  const prompt = text("prompt");
  if (!prompt) return fail(`${at}.prompt`, `${name} needs a prompt`);
  try {
    assertRunPromptLimit(prompt);
  } catch (error) {
    if (error instanceof RunPromptTooLargeError) return fail(`${at}.prompt`, `${name} has a prompt that is too long`);
    throw error;
  }
  return { name, cron, timezone, prompt };
}

/**
 * Read an uploaded bot file. Fields it does not know are ignored, so a file
 * from a newer release of the same version, or one edited by hand, still
 * imports; a known field with a bad value fails with the field named. The bot
 * fields go through the same check a new bot does (`parseBotInput`); the pinned
 * skill never comes from a file. Routines are checked here, before anything is
 * created, so a bad one fails the import instead of leaving half a bot behind.
 */
export function parseBotFile(value: unknown): { file: ParsedBotFile } | { error: BotInputError } {
  if (!isRecord(value)) return fail("file", "The file is not a bot file.");
  if (value.format !== BOT_FILE_FORMAT) return fail("format", "The file is not a bot file.");
  if (value.version !== BOT_FILE_VERSION) {
    return fail("version", typeof value.version === "number" && value.version > BOT_FILE_VERSION
      ? "The file was exported by a newer version of UseAgent."
      : "The file has an unknown version.");
  }
  if (!isRecord(value.bot)) return fail("bot", "The file has no bot in it.");
  const fields: Record<string, unknown> = {};
  for (const key of BOT_FIELDS) if (value.bot[key] !== undefined) fields[key] = value.bot[key];
  const parsed = parseBotInput(fields, null);
  if ("error" in parsed) return parsed;

  const rawRoutines = value.routines ?? [];
  if (!Array.isArray(rawRoutines)) return fail("routines", "routines must be a list");
  if (rawRoutines.length > BOT_FILE_ROUTINES_MAX) {
    return fail("routines", `A bot file brings at most ${BOT_FILE_ROUTINES_MAX} routines.`);
  }
  const routines: BotFileRoutine[] = [];
  for (const [index, raw] of rawRoutines.entries()) {
    const routine = parseRoutine(raw, index);
    if ("error" in routine) return routine;
    routines.push(routine);
  }
  return { file: { input: { ...parsed.input, skillIds: [] }, routines } };
}
