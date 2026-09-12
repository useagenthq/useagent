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

/** The message a failed request should show: human text first, codes last. */
export function apiErrorText(data: unknown, fallback: string): string {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  for (const key of ["message", "reason", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}
