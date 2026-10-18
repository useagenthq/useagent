import type { BotRow } from "../db/schema";

/**
 * Who may change a bot's setup (its standing rules, preset and routines): its
 * creator. Every turn the bot takes runs that setup, a routine's unattended ones
 * as their creator, so nobody else writes it. Others may still message it.
 */
export function botEditableBy(bot: Pick<BotRow, "createdBy">, userId: string | null): boolean {
  return userId !== null && bot.createdBy === userId;
}

/** A routine someone other than its bot's creator added (before botEditableBy
 *  held): it would run as them with rules they do not set, so it does not fire. */
export class RoutineOwnerError extends Error {
  readonly code = "routine_not_bot_owner" as const;

  constructor(botName: string) {
    super(`Only the creator of ${botName} can give it routines, so this one, added by someone else, no longer runs.`);
    this.name = "RoutineOwnerError";
  }
}
