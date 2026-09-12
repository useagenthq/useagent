import type { ApiBot, BotState } from "./types";

/** Roster order: what needs you first, then what is moving, then the rest. */
export const ROSTER_SECTIONS: readonly { state: BotState; label: string }[] = [
  { state: "attention", label: "NEEDS YOU" },
  { state: "working", label: "WORKING" },
  { state: "idle", label: "IDLE" },
];

export interface RosterSection {
  readonly state: BotState;
  readonly label: string;
  readonly bots: readonly ApiBot[];
}

/** Group by derived state in section order; empty sections are dropped. */
export function groupRoster(bots: readonly ApiBot[]): RosterSection[] {
  return ROSTER_SECTIONS.map((section) => ({
    ...section,
    bots: bots.filter((bot) => bot.state === section.state),
  })).filter((section) => section.bots.length > 0);
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

/** Compact relative time: now, 5m, 2h, 3d. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "";
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
