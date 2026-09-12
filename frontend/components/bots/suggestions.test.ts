import { describe, expect, test } from "bun:test";
import { BOT_SUGGESTIONS } from "./suggestions";
import { BOT_AVATAR_ICONS, BOT_AVATAR_TONES } from "./types";

describe("bot suggestions", () => {
  test("cover eight distinct jobs with distinct names and marks", () => {
    expect(BOT_SUGGESTIONS.length).toBe(8);
    const names = BOT_SUGGESTIONS.map((s) => s.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const marks = BOT_SUGGESTIONS.map((s) => `${s.tone}/${s.icon}`);
    expect(new Set(marks).size).toBe(marks.length);
  });

  test("fit the backend limits and the avatar sets", () => {
    for (const s of BOT_SUGGESTIONS) {
      expect(s.name.length).toBeLessThanOrEqual(60);
      expect(s.title.length).toBeLessThanOrEqual(80);
      expect(s.rules.length).toBeLessThanOrEqual(400);
      expect(BOT_AVATAR_ICONS).toContain(s.icon);
      expect(BOT_AVATAR_TONES).toContain(s.tone);
    }
  });

  test("every rule set keeps a person in charge of anything irreversible", () => {
    for (const s of BOT_SUGGESTIONS) {
      expect(s.rules).not.toContain("—");
      expect(s.title).not.toContain("—");
    }
    const guarded = BOT_SUGGESTIONS.filter((s) => /never|nothing sends|a person/i.test(s.rules));
    expect(guarded.length).toBeGreaterThanOrEqual(5);
  });
});
