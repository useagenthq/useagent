// The /memory skill text must MATCH reality (new_mem_prompt.md 7 + the no-gateway
// honesty repro): tools-based when the memory tools are wired, and an explicit
// no-durable-tools warning when they are not - so an agent without tools never
// writes a local memory file or falsely claims a save. Pure - no sandbox.
import { describe, expect, test } from "bun:test";
import {
  MEMORY_SKILL_TEXT,
  MEMORY_SKILL_TEXT_NO_TOOLS,
  memorySkillText,
} from "./memory-skill-text";

describe("memorySkillText", () => {
  test("both variants are valid `memory` skill frontmatter", () => {
    for (const t of [MEMORY_SKILL_TEXT, MEMORY_SKILL_TEXT_NO_TOOLS]) {
      expect(t.startsWith("---\nname: memory\n")).toBe(true);
    }
  });

  test("hasTools=true -> tools-based text (uses the memory tools)", () => {
    const t = memorySkillText(true);
    expect(t).toBe(MEMORY_SKILL_TEXT);
    expect(t).toContain("memory_remember");
    expect(t).toContain("memory_search");
  });

  test("hasTools=false -> honest no-tools text: no fake save, no local file", () => {
    const t = memorySkillText(false);
    expect(t).toBe(MEMORY_SKILL_TEXT_NO_TOOLS);
    // Tells the truth about the absence of tools...
    expect(t).toContain("NO durable memory tools");
    // ...forbids the two observed failure modes...
    expect(t).toContain("/root/.skynet/memory.md");
    expect(t.toLowerCase()).toContain("do not");
    // ...and does NOT advertise the tools it does not have.
    expect(t).not.toContain("memory_remember(");
  });
});
