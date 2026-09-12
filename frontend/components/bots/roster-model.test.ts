import { describe, expect, test } from "bun:test";
import { makeBot as bot } from "./bot-fixture";
import { absoluteTime, orderRoster, outcomeLine, relativeTime, stateLabel } from "./roster-model";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

describe("orderRoster", () => {
  test("needs-you first, then working, then idle; latest activity first within a state, never-used last", () => {
    const ordered = orderRoster([
      bot({ id: "idle-blank", state: "idle" }),
      bot({ id: "idle-old", state: "idle", lastAt: "2026-09-01T08:00:00.000Z" }),
      bot({ id: "hot", state: "attention", pendingApprovals: 1 }),
      bot({ id: "busy", state: "working", lastAt: "2026-09-01T11:00:00.000Z" }),
      bot({ id: "idle-fresh", state: "idle", lastAt: "2026-09-01T11:30:00.000Z" }),
    ]);
    expect(ordered.map((b) => b.id)).toEqual(["hot", "busy", "idle-fresh", "idle-old", "idle-blank"]);
  });
});

describe("stateLabel", () => {
  test("words for the two states that matter, nothing for idle", () => {
    expect(stateLabel("attention")).toBe("Needs you");
    expect(stateLabel("working")).toBe("Working");
    expect(stateLabel("idle")).toBeNull();
  });
});

describe("outcomeLine", () => {
  test("shows a short outcome whole and falls back honestly", () => {
    expect(outcomeLine(bot({ lastOutcome: "PR #482: 2 blockers found", lastAt: "2026-09-01T11:55:00.000Z" }), NOW)).toBe("PR #482: 2 blockers found");
    expect(outcomeLine(bot({ state: "attention", pendingApprovals: 1 }), NOW)).toBe("Waiting on your approval");
    expect(outcomeLine(bot({ state: "attention", pendingApprovals: 3 }), NOW)).toBe("Waiting on 3 approvals");
    expect(outcomeLine(bot({ state: "working" }), NOW)).toBe("Working on it");
    expect(outcomeLine(bot({ homeThreadId: "t1" }), NOW)).toBe("Finished, no summary yet");
    expect(outcomeLine(bot({}), NOW)).toBe("No conversations yet");
  });

  test("a whole reply is not an outcome: the line says when the bot replied instead", () => {
    const reply = "I don't actually have live access to your repositories, so ".repeat(4);
    const at = "2026-09-01T11:56:00.000Z";
    expect(outcomeLine(bot({ lastOutcome: reply, lastAt: at, homeThreadId: "t1" }), NOW)).toBe("Replied 4m ago");
    expect(outcomeLine(bot({ lastOutcome: "Done.\nDetails below.", lastAt: at, homeThreadId: "t1" }), NOW)).toBe("Replied 4m ago");
    expect(outcomeLine(bot({ lastAt: "2026-09-01T11:59:50.000Z", homeThreadId: "t1" }), NOW)).toBe("Replied just now");
    // Before the clock is known (server render) the line stays stable and honest.
    expect(outcomeLine(bot({ lastOutcome: reply, lastAt: at, homeThreadId: "t1" }), null)).toBe("Replied");
  });
});

describe("relativeTime", () => {
  test("compacts to now / m / h / d and stays blank until the clock is known", () => {
    expect(relativeTime("2026-09-01T11:59:40.000Z", NOW)).toBe("now");
    expect(relativeTime("2026-09-01T11:55:00.000Z", NOW)).toBe("5m");
    expect(relativeTime("2026-09-01T10:00:00.000Z", NOW)).toBe("2h");
    expect(relativeTime("2026-08-29T12:00:00.000Z", NOW)).toBe("3d");
    expect(relativeTime("2026-09-01T11:55:00.000Z", null)).toBe("");
    expect(relativeTime(null, NOW)).toBe("");
    expect(relativeTime("garbage", NOW)).toBe("");
  });
});

describe("absoluteTime", () => {
  test("a readable local date once mounted, blank before and for garbage", () => {
    expect(absoluteTime("2026-09-01T11:55:00.000Z", null)).toBe("");
    expect(absoluteTime("garbage", NOW)).toBe("");
    expect(absoluteTime("2026-09-01T11:55:00.000Z", NOW)).toMatch(/2026/);
  });
});
