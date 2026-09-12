import { describe, expect, test } from "bun:test";
import { composeBotContext } from "./prompt-context";

describe("bot prompt context", () => {
  test("lists every bot with its handle and engine, and states the no-impersonation rule", () => {
    const out = composeBotContext([
      { name: "Night Triage", title: "overnight incident triage", engine: "chat" },
      { name: "Nova", title: "", engine: "opencode" },
    ]);
    expect(out).toContain("- Night Triage (@bot/Night Triage) on chat: overnight incident triage");
    expect(out).toContain("- Nova (@bot/Nova) on opencode");
    expect(out).toContain("bot_handoff");
    expect(out).toContain("Never write as the bot");
    expect(out).toContain("chat engine has no browsing");
    expect(out.startsWith("<bots>")).toBe(true);
    expect(out.trimEnd().endsWith("</bots>")).toBe(true);
  });

  test("is empty when the workspace has no bots", () => {
    expect(composeBotContext([])).toBe("");
  });
});
