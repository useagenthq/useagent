import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { composerPlaceholder, getComposerAction } from "./composer";

describe("composer action contract", () => {
  test("keeps idle drafts on the compact send action", () => {
    expect(getComposerAction({ running: false, hasDraft: true, canStop: true })).toEqual({
      kind: "send",
      label: "Send",
    });
  });

  test("labels a non-empty active-run draft as steer", () => {
    expect(getComposerAction({ running: true, hasDraft: true, canStop: true })).toEqual({
      kind: "steer",
      label: "Steer",
    });
  });

  test("keeps an empty active-run draft on the separate stop action", () => {
    expect(getComposerAction({ running: true, hasDraft: false, canStop: true })).toEqual({
      kind: "stop",
      label: "Stop this run",
    });
  });

  test("falls back to a disabled send action when stopping is unavailable", () => {
    expect(getComposerAction({ running: true, hasDraft: false, canStop: false })).toEqual({
      kind: "send",
      label: "Send",
    });
  });
});

describe("composer placeholder honesty", () => {
  test("an explicit caller placeholder always wins", () => {
    expect(
      composerPlaceholder({ explicit: "Reply to Skynet…", agentSlash: true, commandCount: 3 }),
    ).toBe("Reply to Skynet…");
  });

  test("hero hints the real / agent affordance", () => {
    expect(composerPlaceholder({ agentSlash: true, commandCount: 0 })).toBe(
      "Ask anything, / for agents",
    );
  });

  test("a ready command catalog hints / commands", () => {
    expect(composerPlaceholder({ agentSlash: false, commandCount: 2 })).toBe(
      "Ask anything, / for commands",
    );
  });

  test("no slash affordance means no hint - @ files and $ skills are never advertised", () => {
    expect(composerPlaceholder({ agentSlash: false, commandCount: 0 })).toBe("Ask anything...");
  });
});

describe("composer banner stack contract", () => {
  test("stacks error, provider, then live-status above the input card - one slot, no fetches", () => {
    const src = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
    const error = src.indexOf("<ThreadErrorBanner");
    const provider = src.indexOf("<ProviderStatusBanner");
    const pill = src.indexOf("<BackgroundStatusPill");
    const inputCard = src.indexOf("<PromptInput");

    expect(error).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(error);
    expect(pill).toBeGreaterThan(provider);
    expect(inputCard).toBeGreaterThan(pill);
    // The banners are call-site fed props; the composer itself adds no fetch.
    expect(src).not.toContain("fetch(");
  });
});
