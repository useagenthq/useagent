import { describe, expect, test } from "bun:test";
import { groupRoster, outcomeLine, relativeTime } from "./roster-model";
import type { ApiBot } from "./types";

function bot(overrides: Partial<ApiBot>): ApiBot {
  return {
    id: overrides.id ?? "b1",
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
    archived: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    state: "idle",
    lastOutcome: null,
    lastAt: null,
    pendingApprovals: 0,
    ...overrides,
  };
}

describe("groupRoster", () => {
  test("orders needs-you, working, idle and drops empty sections", () => {
    const sections = groupRoster([
      bot({ id: "idle", state: "idle" }),
      bot({ id: "hot", state: "attention", pendingApprovals: 1 }),
      bot({ id: "busy", state: "working" }),
    ]);
    expect(sections.map((section) => section.label)).toEqual(["NEEDS YOU", "WORKING", "IDLE"]);
    expect(sections.map((section) => section.bots.map((b) => b.id))).toEqual([["hot"], ["busy"], ["idle"]]);
    expect(groupRoster([bot({ state: "working" })]).map((s) => s.label)).toEqual(["WORKING"]);
  });
});

describe("outcomeLine", () => {
  test("prefers the bot's own summary and falls back honestly", () => {
    expect(outcomeLine(bot({ lastOutcome: "PR #482: 2 blockers found" }))).toBe("PR #482: 2 blockers found");
    expect(outcomeLine(bot({ state: "attention", pendingApprovals: 1 }))).toBe("Waiting on your approval");
    expect(outcomeLine(bot({ state: "attention", pendingApprovals: 3 }))).toBe("Waiting on 3 approvals");
    expect(outcomeLine(bot({ state: "working" }))).toBe("Working on it");
    expect(outcomeLine(bot({ homeThreadId: "t1" }))).toBe("Finished, no summary yet");
    expect(outcomeLine(bot({}))).toBe("No conversations yet");
  });
});

describe("relativeTime", () => {
  test("compacts to now / m / h / d", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    expect(relativeTime("2026-09-01T11:59:40.000Z", now)).toBe("now");
    expect(relativeTime("2026-09-01T11:55:00.000Z", now)).toBe("5m");
    expect(relativeTime("2026-09-01T10:00:00.000Z", now)).toBe("2h");
    expect(relativeTime("2026-08-29T12:00:00.000Z", now)).toBe("3d");
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime("garbage", now)).toBe("");
  });
});
