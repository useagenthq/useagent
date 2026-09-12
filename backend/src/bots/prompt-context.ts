import type { BotRow } from "../db/schema";
import { MAX_HANDOFF_DEPTH, botOwningThread, handoffsAvailable, threadAncestors } from "./handoffs";
import { listBotRows } from "./repo";

const BOTS_MAX = 25;

/** Names and titles are org-authored text that lands in every turn: never let them close or open a tag. */
function plain(text: string): string {
  return text.replace(/[<>\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * What an agent turn is told about the workspace's bots: who they are, how to
 * address them, and the one rule that keeps delegation honest. Without this
 * the model cannot know a bot exists, so "ask Night Triage" gets answered by
 * the agent itself, in the bot's voice. Empty when there are no bots.
 */
export function composeBotContext(
  bots: readonly Pick<BotRow, "name" | "title" | "engine">[],
  options: { readonly self?: string | null } = {},
): string {
  const others = bots.filter((bot) => bot.name !== options.self);
  if (others.length === 0) return "";
  const selfLine = options.self ? [`You are ${plain(options.self)} in this thread. You cannot hand work to yourself; do your own part here.`] : [];
  const lines = others.slice(0, BOTS_MAX).map((bot) => {
    const name = plain(bot.name);
    const title = plain(bot.title) ? `: ${plain(bot.title)}` : "";
    return `- ${name} (@bot/${name}) on ${bot.engine}${title}`;
  });
  if (others.length > BOTS_MAX) lines.push(`- (${others.length - BOTS_MAX} more bots are listed on the Bots page)`);
  return [
    "<bots>",
    "Bots in this workspace. Each is a durable named agent with its own engine, model, rules and thread; a handoff to it opens or continues that bot's delegated thread and runs there, not here.",
    ...selfLine,
    ...lines,
    "",
    "Rules for bots:",
    "- When the message names a bot, or asks you to ask, tell or have a bot do something, hand exactly that part to the bot with bot_handoff, once per bot per message, and do not do that part yourself. A repeated handoff to the same bot from this thread continues its existing delegated thread; the tool replies with that thread id.",
    "- Bots take precedence over generic fan-out for the parts addressed to them: never open child sessions for work you handed to a bot. Fan-out rules apply only to the remaining work.",
    "- Never write as the bot or sign as it. You are not the bot. Report that the work was handed off and to which thread. Before claiming the overall task is done, read the bot's settled result with child_session_gather and synthesize it; do not busy-poll, and if it is still running say so and finish your own part.",
    "- Approval-bound or destructive steps stay in this thread; hand a bot only what it can complete on its own.",
    "- A bot on the chat engine has no browsing, files, code or sandbox. If the ask needs those, say so plainly instead of answering in the bot's place.",
    "</bots>",
    "",
  ].join("\n");
}

/** The block for a run's org: empty when bots or handoffs are unavailable, or the list cannot be read. */
export async function botContextForOrg(orgId: string | null, threadId: string | null): Promise<string> {
  if (!orgId || !handoffsAvailable(orgId)) return "";
  const [rows, owner, chain] = await Promise.all([
    listBotRows(orgId).catch(() => []),
    threadId ? botOwningThread(orgId, threadId).catch(() => null) : null,
    threadId ? threadAncestors(orgId, threadId).catch(() => ({ threadIds: [] as string[], familyThreadId: threadId })) : { threadIds: [] as string[], familyThreadId: "" },
  ]);
  // Below the depth cap no handoff is possible, so the block would only mislead.
  if (chain.threadIds.length >= MAX_HANDOFF_DEPTH) return "";
  return composeBotContext(rows, { self: owner?.name ?? null });
}
