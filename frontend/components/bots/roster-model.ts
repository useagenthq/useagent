import type { ApiBot, BotState } from "./types";
import { botStatus } from "./bot-status";
import { relativeTime as formatAgo, relativeTimeShort } from "@/utils/format";

/** Roster order: what needs you first, then what is moving, then the rest. */
const ORDER: readonly BotState[] = ["attention", "working", "idle"];

/** An outcome the roster can show whole on one line; anything longer is the reply itself. */
const SHORT_OUTCOME_MAX = 120;

function activityTime(bot: Pick<ApiBot, "lastAt">): number {
  const time = bot.lastAt ? Date.parse(bot.lastAt) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

/** Same state: latest activity first, so a fresh result never sinks under never-used bots. */
export function orderRoster(bots: readonly ApiBot[]): ApiBot[] {
  return bots.toSorted(
    (a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || activityTime(b) - activityTime(a),
  );
}

/** The state in words for every bot projection. */
export function stateLabel(state: BotState): string {
  return botStatus(state).label;
}

/** The one line under the name: the bot's own outcome when it is short, else an honest fallback. */
export function outcomeLine(
  bot: Pick<ApiBot, "state" | "lastOutcome" | "lastAt" | "homeThreadId" | "pendingApprovals">,
  now: number | null,
): string {
  if (bot.state === "attention") {
    return bot.pendingApprovals > 1
      ? `${bot.pendingApprovals} requests need your input`
      : "Waiting for your input";
  }
  const outcome = bot.lastOutcome?.trim() ?? "";
  if (outcome && outcome.length <= SHORT_OUTCOME_MAX && !outcome.includes("\n")) return outcome;
  if (bot.state === "working") return "Working on it";
  if (bot.lastAt) {
    const ago = agoText(bot.lastAt, now);
    if (!ago) return "Replied";
    return ago === "just now" ? "Replied just now" : `Replied ${ago}`;
  }
  return bot.homeThreadId ? "Finished, no summary yet" : "No conversations yet";
}

/** "4m ago", or the date once it is older than a month. "" until `now` is known, so the
 * server render and the client agree. */
function agoText(iso: string, now: number | null): string {
  if (now === null) return "";
  const then = Date.parse(iso);
  return Number.isNaN(then) ? "" : formatAgo(then, now);
}

/** Compact relative time: now, 5m, 2h, 3d. "" until `now` is known (after mount). */
export function relativeTime(iso: string | null, now: number | null): string {
  if (!iso || now === null) return "";
  const then = Date.parse(iso);
  return Number.isNaN(then) ? "" : relativeTimeShort(then, now);
}

/** The full local date behind a relative time. "" until `now` is known, so server and client agree. */
export function absoluteTime(iso: string, now: number | null): string {
  if (now === null) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  return then.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
