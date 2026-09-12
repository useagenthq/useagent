import type { BotRow } from "../db/schema";

const BOTS_MAX = 25;

/**
 * What an agent turn is told about the workspace's bots: who they are, how to
 * address them, and the one rule that keeps delegation honest. Without this
 * the model cannot know a bot exists, so "ask Night Triage" gets answered by
 * the agent itself, in the bot's voice. Empty when there are no bots.
 */
export function composeBotContext(bots: readonly Pick<BotRow, "name" | "title" | "engine">[]): string {
  if (bots.length === 0) return "";
  const lines = bots.slice(0, BOTS_MAX).map((bot) => {
    const title = bot.title.trim() ? `: ${bot.title.trim()}` : "";
    return `- ${bot.name} (@bot/${bot.name}) on ${bot.engine}${title}`;
  });
  return [
    "<bots>",
    "Bots in this workspace. Each is a durable named agent with its own engine, model, rules and thread; a handoff to it opens or continues that bot's delegated thread and runs there, not here.",
    ...lines,
    "",
    "Rules for bots:",
    "- When the message names a bot, or asks you to ask, tell or have a bot do something, hand exactly that part to the bot with bot_handoff (an @bot mention in the message has already done this for you) and stop there. Do not do the bot's part yourself.",
    "- Never write as the bot or sign as it. You are not the bot. Report that the work was handed off and to which thread; read the bot's result with child_session_gather only when the user asks for it or the bot has settled.",
    "- A bot on the chat engine has no browsing, files, code or sandbox. If the ask needs those, say so plainly instead of answering in the bot's place.",
    "</bots>",
    "",
  ].join("\n");
}
