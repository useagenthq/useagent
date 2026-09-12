/**
 * Idempotency-key grammar for bot handoffs. Kept apart from handoffs.ts so the
 * relationship repo can read the grammar back (which parent run followed up
 * into a delegated thread) without importing the dispatch code.
 */

const MENTION_PREFIX = "bot-handoff";
const FOLLOWUP_PREFIX = "bot-handoff-followup";

/** The key the @mention path hands a run's message off under: one per (run, bot). */
export function mentionHandoffKey(parentRunId: string, botId: string): string {
  return `${MENTION_PREFIX}:${parentRunId}:${botId}`;
}

/** The command key of a follow-up into the bot's existing delegated thread. */
export function followupHandoffKey(
  parentThreadId: string,
  botId: string,
  callerKey: string,
): string {
  return `${FOLLOWUP_PREFIX}:${parentThreadId}:${botId}:${callerKey}`;
}

/** Prefix match for follow-up command rows (SQL LIKE pattern). */
export const FOLLOWUP_KEY_PATTERN = `${FOLLOWUP_PREFIX}:%`;

/**
 * The parent-thread run whose @mention produced a follow-up command, or null
 * when the follow-up came from elsewhere (the gateway tool uses its own keys).
 * Ids never contain ":" so a plain split is exact.
 */
export function mentionFollowupSourceRunId(key: string): string | null {
  const parts = key.split(":");
  if (parts.length !== 6) return null;
  const [prefix, , botId, mention, runId, mentionBotId] = parts;
  if (prefix !== FOLLOWUP_PREFIX || mention !== MENTION_PREFIX) return null;
  if (!runId || botId !== mentionBotId) return null;
  return runId;
}
