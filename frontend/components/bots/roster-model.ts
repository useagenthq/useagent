import type { ApiBot, BotState } from "./types";

/** Roster order: what needs you first, then what is moving, then the rest. */
const ORDER: readonly BotState[] = ["attention", "working", "idle"];

export function orderRoster(bots: readonly ApiBot[]): ApiBot[] {
  return bots.toSorted((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
}

/** The one line under the name: the bot's own outcome, or an honest fallback. */
export function outcomeLine(bot: Pick<ApiBot, "state" | "lastOutcome" | "homeThreadId" | "pendingApprovals">): string {
  if (bot.state === "attention") {
    return bot.pendingApprovals === 1 ? "Waiting on your approval" : `Waiting on ${bot.pendingApprovals} approvals`;
  }
  if (bot.lastOutcome) return bot.lastOutcome;
  if (bot.state === "working") return "Working on it";
  return bot.homeThreadId ? "Finished, no summary yet" : "No conversations yet";
}

/** Compact relative time: now, 5m, 2h, 3d. "" until `now` is known (after mount). */
export function relativeTime(iso: string | null, now: number | null): string {
  if (!iso || now === null) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
