/** Wire shape of GET /api/bots - mirrors the backend BotView. */
export type BotState = "attention" | "working" | "idle";

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
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  state: BotState;
  lastOutcome: string | null;
  lastAt: string | null;
  pendingApprovals: number;
}

export const BOT_AVATAR_TONES = [
  "blue",
  "violet",
  "emerald",
  "amber",
  "rose",
  "cyan",
  "fuchsia",
  "slate",
] as const;

export const BOT_AVATAR_ICONS = [
  "robot",
  "code",
  "research",
  "chart",
  "megaphone",
  "sales",
  "support",
  "pen",
  "compass",
] as const;

export const ENGINE_LABELS: Record<string, string> = {
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
