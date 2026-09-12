import {
  BOT_AVATAR_ICONS,
  BOT_AVATAR_TONES,
  type BotAvatarIcon,
  type BotAvatarTone,
  type BotState,
} from "@useagent/agent-client";

export { BOT_AVATAR_ICONS, BOT_AVATAR_TONES };
export type { BotAvatarIcon, BotAvatarTone, BotState };

/** Wire shape of GET /api/bots - mirrors the backend BotView. */
export interface ApiBot {
  id: string;
  name: string;
  title: string;
  rules: string;
  engine: string;
  model: string | null;
  skillIds: string[];
  repos: string[];
  memoryScope: "org" | "personal";
  avatarTone: string;
  avatarIcon: string;
  homeThreadId: string | null;
  presetLocked: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  state: BotState;
  lastOutcome: string | null;
  lastAt: string | null;
  pendingApprovals: number;
  /** Enabled routines (schedules owned by this bot). */
  routines: number;
  /** Delegated threads opened for this bot by @mentions, and their root run ids. */
  handoffs: number;
  handoffThreadIds: string[];
}

/** Wire shape of GET /api/bots/:id/routines. */
export interface ApiRoutine {
  id: string;
  name: string;
  cron: string;
  timezone: string | null;
  prompt: string;
  enabled: boolean;
  lastFiredAt: string | null;
  createdAt: string;
}

export interface ApiFiring {
  id: string;
  run_id: string;
  fired_at: string;
  trigger: string;
  run_status: string | null;
  run_summary: string | null;
}

const ENGINE_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  chat: "Chat",
  mock: "Mock",
};

export function engineLabel(id: string): string {
  return ENGINE_LABELS[id] ?? id;
}

/** Only the chat engine answers from context alone; every other engine runs in its own sandbox. */
export function engineHasComputer(id: string): boolean {
  return id !== "chat";
}

export function memoryScopeLabel(scope: ApiBot["memoryScope"]): string {
  return scope === "org" ? "Team" : "Personal";
}

/** What a request that never reached the backend should say, with the recovery step. */
export const OFFLINE_MESSAGE = "Unable to reach the server. Check your connection and try again.";

/** The message a failed request should show: human text first, codes last. */
export function apiErrorText(data: unknown, fallback: string): string {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  for (const key of ["message", "reason", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}
