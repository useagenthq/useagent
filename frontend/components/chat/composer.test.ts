import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { compactAvailable, composerPlaceholder, getComposerAction } from "./composer-model";

describe("composer action contract", () => {
  test("keeps idle drafts on the compact send action", () => {
    expect(getComposerAction({ running: false, hasDraft: true, canStop: true })).toEqual({
      kind: "send",
      label: "Send",
    });
  });

  test("labels a non-empty active-run draft as Queue", () => {
    expect(getComposerAction({ running: true, hasDraft: true, canStop: true })).toEqual({
      kind: "steer",
      label: "Queue",
    });
  });

  test("keeps an empty active-run draft on the separate stop action", () => {
    expect(getComposerAction({ running: true, hasDraft: false, canStop: true })).toEqual({
      kind: "stop",
      label: "Stop this task",
    });
  });

  test("stays on Queue while running when the footer owns Stop (no stop handler here)", () => {
    expect(getComposerAction({ running: true, hasDraft: false, canStop: false })).toEqual({
      kind: "steer",
      label: "Queue",
    });
  });
});

describe("compact now availability", () => {
  const quiet = {
    running: false,
    pending: false,
    turnStatuses: ["completed"],
    controlOpen: false,
    locked: false,
    commands: [{ name: "compact" }],
  };

  test("offered only on a quiet thread whose engine has the command", () => {
    expect(compactAvailable(quiet)).toBe(true);
    expect(compactAvailable({ ...quiet, commands: [{ name: "review" }] })).toBe(false);
    expect(compactAvailable({ ...quiet, running: true })).toBe(false);
    expect(compactAvailable({ ...quiet, pending: true })).toBe(false);
    expect(compactAvailable({ ...quiet, controlOpen: true })).toBe(false);
    expect(compactAvailable({ ...quiet, locked: true })).toBe(false);
  });

  test("any queued turn blocks it, a queued spawned session included (it holds the lane even when no row shows it)", () => {
    expect(compactAvailable({ ...quiet, turnStatuses: ["completed", "queued"] })).toBe(false);
  });
});

describe("composer placeholder honesty", () => {
  test("an explicit caller placeholder always wins", () => {
    expect(
      composerPlaceholder({ explicit: "Reply to UseAgent…", agentSlash: true, commandCount: 3 }),
    ).toBe("Reply to UseAgent…");
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

  test("the reply composer advertises @ once mentions are on, and bots only when they exist", () => {
    const reply = { lead: "Reply to Agent", agentSlash: false, mentions: true };
    expect(composerPlaceholder({ ...reply, commandCount: 0, bots: true })).toBe(
      "Reply to Agent, @ for context or a bot",
    );
    expect(composerPlaceholder({ ...reply, commandCount: 0, bots: false })).toBe(
      "Reply to Agent, @ for context",
    );
    expect(composerPlaceholder({ ...reply, commandCount: 3, bots: true })).toBe(
      "Reply to Agent, / for commands, @ for context or a bot",
    );
  });

  test("a narrow screen keeps the lead and drops the hints so the line never wraps", () => {
    expect(
      composerPlaceholder({ lead: "Reply to Agent", agentSlash: false, commandCount: 3, mentions: true, bots: true, compact: true }),
    ).toBe("Reply to Agent...");
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
