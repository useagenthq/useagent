// Regression lock for the context-split bug (north star "Fix the Current Context
// Bug First"): resumed native sessions used to receive ONLY the raw prompt, so
// freshly recalled team memory was silently dropped on every continuing turn.
// composeTurnPrompt is the single source of truth every adapter now routes
// through — testing it proves the fix for OpenCode, ACP, and the sandbox paths.

import { describe, expect, test } from "bun:test";
import { AGENT_OPERATING_RULES, composeTurnPrompt } from "./types";

const ctx = (over: Partial<{ prompt: string; bootstrapContext: string; turnContext: string }> = {}) => ({
  prompt: "USER",
  bootstrapContext: "BOOT",
  turnContext: "TURN",
  ...over,
});

const R = AGENT_OPERATING_RULES;

describe("composeTurnPrompt — fresh vs resumed context", () => {
  test("fresh native session gets operating-rules + bootstrap + turn + prompt, in that order", () => {
    expect(composeTurnPrompt(ctx(), false)).toBe(`${R}BOOTTURNUSER`);
  });

  test("resumed session gets turn + prompt, but NOT bootstrap history or re-injected rules", () => {
    const out = composeTurnPrompt(ctx(), true);
    expect(out).toBe("TURNUSER");
    expect(out).not.toContain("BOOT"); // native session already holds the thread
    expect(out).not.toContain("operating_rules"); // and already saw the rules on its first turn
  });

  test("REGRESSION: a resumed session STILL carries fresh turnContext (memory not dropped)", () => {
    // The bug: resumed → only ctx.prompt, so this recalled fact never reached the model.
    expect(composeTurnPrompt(ctx({ turnContext: "RECALLED_FACT" }), true)).toContain("RECALLED_FACT");
  });

  test("fresh run ALWAYS carries the operating rules (graceful-degradation guardrail)", () => {
    const bare = ctx({ bootstrapContext: "", turnContext: "" });
    expect(composeTurnPrompt(bare, false)).toBe(`${R}USER`);
    expect(composeTurnPrompt(bare, false)).toContain("operating_rules");
    // resumed stays lean — no bootstrap, no rules, just the fresh turn + prompt.
    expect(composeTurnPrompt(bare, true)).toBe("USER");
  });

  test("root fresh run (no bootstrap yet) still injects rules + turnContext", () => {
    expect(composeTurnPrompt(ctx({ bootstrapContext: "" }), false)).toBe(`${R}TURNUSER`);
  });
});
