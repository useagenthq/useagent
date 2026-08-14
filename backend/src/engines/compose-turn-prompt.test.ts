// Regression lock for the context-split bug (north star "Fix the Current Context
// Bug First"): resumed native sessions used to receive ONLY the raw prompt, so
// freshly recalled team memory was silently dropped on every continuing turn.
// composeTurnPrompt is the single source of truth every adapter now routes
// through — testing it proves the fix for OpenCode, ACP, and the sandbox paths.

import { describe, expect, test } from "bun:test";
import {
  AGENT_OPERATING_RULES,
  AGENT_SKILL_DISCOVERY_RULES,
  composeTurnPrompt,
} from "./types";

const ctx = (over: Partial<{ prompt: string; bootstrapContext: string; turnContext: string; skillContext: string; commandName: string | null }> = {}) => ({
  prompt: "USER",
  bootstrapContext: "BOOT",
  turnContext: "TURN",
  ...over,
});

const R = AGENT_OPERATING_RULES;
const S = AGENT_SKILL_DISCOVERY_RULES;

describe("composeTurnPrompt — fresh vs resumed context", () => {
  test("fresh native session gets operating-rules + bootstrap + turn + prompt, in that order", () => {
    expect(composeTurnPrompt(ctx(), false)).toBe(`${R}BOOT${S}TURNUSER`);
  });

  test("resumed session gets current skill discovery + turn + prompt, but not bootstrap history", () => {
    const out = composeTurnPrompt(ctx(), true);
    expect(out).toBe(`${S}TURNUSER`);
    expect(out).not.toContain("BOOT"); // native session already holds the thread
    expect(out).not.toContain("operating_rules"); // and already saw the global rules on its first turn
    expect(out).toContain("skills_list");
    expect(out).toContain("skill_activate");
  });

  test("REGRESSION: a resumed session STILL carries fresh turnContext (memory not dropped)", () => {
    // The bug: resumed → only ctx.prompt, so this recalled fact never reached the model.
    expect(composeTurnPrompt(ctx({ turnContext: "RECALLED_FACT" }), true)).toContain("RECALLED_FACT");
  });

  test("fresh run ALWAYS carries the operating rules (graceful-degradation guardrail)", () => {
    const bare = ctx({ bootstrapContext: "", turnContext: "" });
    expect(composeTurnPrompt(bare, false)).toBe(`${R}${S}USER`);
    expect(composeTurnPrompt(bare, false)).toContain("operating_rules");
    // resumed stays lean but still receives current catalog-discovery guidance.
    expect(composeTurnPrompt(bare, true)).toBe(`${S}USER`);
  });

  test("fresh browser sessions use bounded inspection without publishing internal frames", () => {
    expect(R).toContain("prefer bounded DOM/locator actions");
    expect(R).toContain("limit it by target or depth");
    expect(R).toContain("viewport screenshot plus coordinate tools");
    expect(R).toContain("Inspection screenshots stay internal");
    expect(R).toContain("publish an artifact only when the user requests");
    expect(R).toContain("Do not close the browser unless the user asks");
  });

  test("root fresh run (no bootstrap yet) still injects rules + turnContext", () => {
    expect(composeTurnPrompt(ctx({ bootstrapContext: "" }), false)).toBe(`${R}${S}TURNUSER`);
  });

  // A VALIDATED native command (commandName set; prompt already the exact `/name args` bytes)
  // is delivered BYTE-VERBATIM. Crucially the discriminator is the VALIDATED commandName, NOT
  // the leading "/", so arbitrary slash-prefixed text can never silently bypass the context.
  describe("validated native command is delivered byte-verbatim", () => {
    test("a fresh validated command turn skips ALL prefixes (rules/bootstrap/skill/memory)", () => {
      const out = composeTurnPrompt(ctx({ prompt: "/review src/app.ts", commandName: "review", skillContext: "SKILL" }), false);
      expect(out).toBe("/review src/app.ts");
      expect(out).not.toContain("operating_rules");
      expect(out).not.toContain("BOOT");
      expect(out).not.toContain("SKILL");
      expect(out).not.toContain("TURN");
    });

    test("a resumed validated command turn is verbatim too (no turnContext prepended)", () => {
      expect(composeTurnPrompt(ctx({ prompt: "/status", commandName: "status" }), true)).toBe("/status");
    });

    test("SECURITY: a raw prompt that starts with '/' but is NOT a validated command keeps the FULL prefix", () => {
      // The old code skipped context for ANY leading-slash prompt; now only commandName does.
      const out = composeTurnPrompt(ctx({ prompt: "/etc/passwd please read this", commandName: null }), false);
      expect(out).toBe(`${R}BOOT${S}TURN/etc/passwd please read this`);
    });

    test("SECURITY: leading whitespace + slash without a validated command still gets the prefix", () => {
      const out = composeTurnPrompt(ctx({ prompt: "  /deploy prod" }), false);
      expect(out).toBe(`${R}BOOT${S}TURN  /deploy prod`);
    });

    test("a prompt that only MENTIONS a slash mid-sentence is NOT a command (keeps the prefix)", () => {
      const out = composeTurnPrompt(ctx({ prompt: "run the /review command please" }), false);
      expect(out).toBe(`${R}BOOT${S}TURNrun the /review command please`);
    });
  });
});
