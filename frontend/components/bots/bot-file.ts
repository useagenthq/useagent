import { backendFetch } from "@/lib/backend-fetch";
import { downloadTextFile } from "@/lib/download-file";
import { type ApiBot, apiErrorText, OFFLINE_MESSAGE } from "./types";

/**
 * A bot as a file, the shape GET /api/bots/:id/export answers and POST
 * /api/bots/import reads (backend/src/bots/transfer.ts). The browser only reads
 * what it shows before importing; the server checks the rest.
 */
export const BOT_FILE_FORMAT = "useagent.bot";

/** An opened bot file: the parsed document as it will be sent, plus what the dialog shows. */
export interface BotFileDraft {
  readonly document: Record<string, unknown> & { readonly bot: Record<string, unknown> };
  readonly name: string;
  readonly title: string;
  readonly engine: string;
  readonly avatarTone: string;
  readonly avatarIcon: string;
  readonly repos: readonly string[];
  readonly routines: number;
}

/** What POST /api/bots/import answers on success. */
export interface BotImportResult {
  readonly bot: ApiBot;
  readonly routines: number;
  readonly skipped: { readonly repos: readonly string[]; readonly model: string | null };
}

const NOT_A_BOT_FILE = "This file is not a bot file. Choose a file made with Export bot.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A file name from the bot's name: letters and numbers kept, anything else one hyphen. */
export function botFileName(name: string): string {
  const stem = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `${stem || "bot"}.bot.json`;
}

/** Read an opened file as a bot file, or say why it is not one. */
export function readBotFile(content: string): { draft: BotFileDraft } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { error: NOT_A_BOT_FILE };
  }
  if (!isRecord(parsed) || parsed.format !== BOT_FILE_FORMAT || !isRecord(parsed.bot))
    return { error: NOT_A_BOT_FILE };
  const bot = parsed.bot;
  return {
    draft: {
      document: { ...parsed, bot },
      name: text(bot.name),
      title: text(bot.title),
      engine: text(bot.engine),
      avatarTone: text(bot.avatarTone) || "blue",
      avatarIcon: text(bot.avatarIcon) || "robot",
      repos: Array.isArray(bot.repos)
        ? bot.repos.filter((repo): repo is string => typeof repo === "string")
        : [],
      routines: Array.isArray(parsed.routines) ? parsed.routines.length : 0,
    },
  };
}

/** Download the bot as a file. null when the download started, else the message to show. */
export async function exportBot(bot: Pick<ApiBot, "id" | "name">): Promise<string | null> {
  let response: Response;
  try {
    response = await backendFetch(`/api/bots/${bot.id}/export`);
  } catch {
    return OFFLINE_MESSAGE;
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !isRecord(data))
    return apiErrorText(data, "Unable to export the bot. Try again.");
  downloadTextFile(
    `${JSON.stringify(data, null, 2)}\n`,
    botFileName(bot.name),
    "application/json;charset=utf-8",
  );
  return null;
}

/** Import the file under `name`. A refusal names the field it is about, when it is about one. */
export async function importBot(
  draft: BotFileDraft,
  name: string,
): Promise<{ result: BotImportResult } | { error: string; field: string | null }> {
  let response: Response;
  try {
    response = await backendFetch("/api/bots/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft.document, bot: { ...draft.document.bot, name } }),
    });
  } catch {
    return { error: OFFLINE_MESSAGE, field: null };
  }
  // The bots routes take a body of up to 256 KB; a bigger file never reaches the import.
  if (response.status === 413)
    return { error: "This bot file is too large to import.", field: null };
  const data = (await response.json().catch(() => ({}))) as Partial<BotImportResult> & {
    field?: unknown;
  };
  if (!response.ok || !data.bot) {
    return {
      error: apiErrorText(data, "Unable to import the bot. Try again."),
      field: typeof data.field === "string" ? data.field : null,
    };
  }
  return {
    result: {
      bot: data.bot,
      routines: typeof data.routines === "number" ? data.routines : 0,
      skipped: { repos: data.skipped?.repos ?? [], model: data.skipped?.model ?? null },
    },
  };
}

/** What the import left out, in plain words; empty when it brought everything. */
export function importNotes(result: BotImportResult): string[] {
  const notes: string[] = [];
  const { repos, model } = result.skipped;
  if (repos.length > 0) {
    notes.push(
      `${repos.length === 1 ? "This repository was" : "These repositories were"} left out because this workspace can't reach ${repos.length === 1 ? "it" : "them"}: ${repos.join(", ")}. Add repositories in Bot details before the first message.`,
    );
  }
  if (model)
    notes.push(
      `The model ${model} was left out because this workspace doesn't offer it. The bot uses the default model.`,
    );
  return notes;
}
