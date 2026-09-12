import type { ApiBot } from "./types";

/** A complete ApiBot for tests; override what the case is about. */
export function makeBot(overrides: Partial<ApiBot> = {}): ApiBot {
  return {
    id: "b1",
    name: "Atlas",
    title: "Code reviewer",
    rules: "",
    engine: "opencode",
    model: null,
    skillIds: [],
    repos: [],
    memoryScope: "org",
    avatarTone: "blue",
    avatarIcon: "robot",
    homeThreadId: null,
    presetLocked: false,
    archived: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    state: "idle",
    lastOutcome: null,
    lastAt: null,
    pendingApprovals: 0,
    routines: 0,
    handoffs: 0,
    handoffThreadIds: [],
    ...overrides,
  };
}
