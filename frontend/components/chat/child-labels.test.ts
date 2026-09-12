import { describe, expect, test } from "bun:test";
import { childGroupLabel, childKindLabel } from "./child-labels";

describe("childKindLabel", () => {
  test("names a bot's thread by its bot and everything else by what it is", () => {
    expect(childKindLabel("bot_thread", "Nova")).toBe("Nova · bot thread");
    expect(childKindLabel("bot_thread")).toBe("bot thread");
    expect(childKindLabel("subagent")).toBe("subagent");
    expect(childKindLabel("child_thread")).toBe("child thread");
    expect(childKindLabel("spawned_session")).toBe("spawned session");
  });
});

describe("childGroupLabel", () => {
  test("counts each kind separately, pluralises, and skips zeros", () => {
    expect(childGroupLabel({ subagent: 2, bot_thread: 1 })).toBe("2 subagents, 1 bot thread");
    expect(childGroupLabel({ subagent: 1 })).toBe("1 subagent");
    expect(childGroupLabel({ bot_thread: 2, spawned_session: 1, child_thread: 0 })).toBe(
      "2 bot threads, 1 spawned session",
    );
    expect(childGroupLabel({})).toBe("");
  });
});
