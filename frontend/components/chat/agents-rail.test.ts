import { describe, expect, test } from "bun:test";
import { childElapsedMs, childStatusLabel } from "./agents-rail";
import type { SubagentCard } from "./subagents";

describe("agents rail child state labels", () => {
  test("uses the explicit resumable flag for idle children", () => {
    expect(childStatusLabel("idle", true)).toBe("Idle · resumable");
    expect(childStatusLabel("idle", false)).toBe("Idle");
  });

  test("keeps the legacy idle label when no resumability signal exists", () => {
    expect(childStatusLabel("idle", null)).toBe("Idle · resumable");
  });

  test("uses provider duration for synthetic canonical timestamps and never shows 0ms", () => {
    const card: SubagentCard = {
      id: "canonical-child-child-1",
      title: "Research checkout",
      childSessionId: "child-1",
      callId: "call-1",
      aliases: ["call-1", "child-1"],
      status: "Completed",
      startedAt: 1,
      lastActivityAt: 2,
    };

    expect(childElapsedMs(card, 10_000, false, 1_234)).toBe(1_234);
    expect(childElapsedMs(card, 10_000, false, null)).toBeNull();
  });
});
