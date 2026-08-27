// Regression lock for the context-split bug (north star "Fix the Current Context
// Bug First"): resumed native sessions used to receive ONLY the raw prompt, so
// freshly recalled team memory was silently dropped on every continuing turn.
// composeTurnPrompt is the single source of truth every adapter now routes
// through — testing it proves the fix for OpenCode, ACP, and the sandbox paths.

import { describe, expect, test } from "bun:test";
import type { ExecutionCapabilitySnapshot } from "@useagent/agent-harness/canonical";
import {
  AGENT_OPERATING_RULES,
  AGENT_SKILL_DISCOVERY_RULES,
  AGENT_WORKFLOW_ROUTING_RULES,
  composeTurnPrompt,
} from "./types";
import { executionCapabilityPrompt } from "./execution-capabilities";

const ctx = (
  over: Partial<{
    prompt: string;
    bootstrapContext: string;
    turnContext: string;
    resourceContext: string;
    skillContext: string;
    skillCatalogContext: string;
    commandName: string | null;
  }> = {},
) => ({
  prompt: "USER",
  bootstrapContext: "BOOT",
  turnContext: "TURN",
  ...over,
});

const R = AGENT_OPERATING_RULES;
const S = AGENT_SKILL_DISCOVERY_RULES;
const W = AGENT_WORKFLOW_ROUTING_RULES;
const EXECUTION: ExecutionCapabilitySnapshot = {
  version: 1,
  runtime: "sandbox",
  facilities: {
    files: { availability: "ready", access: { kind: "native" } },
    shell: { availability: "ready", access: { kind: "native" } },
    terminal: { availability: "ready", access: { kind: "native" } },
    desktop: {
      availability: "on_demand",
      access: {
        kind: "useagent_gateway",
        discovery: "direct",
        operations: ["computer_screenshot", "computer_sequence"],
      },
    },
    browser: {
      availability: "on_demand",
      access: {
        kind: "useagent_gateway",
        discovery: "direct",
        operations: ["computer_screenshot", "computer_sequence"],
      },
    },
    tools: {
      availability: "ready",
      access: { kind: "useagent_gateway", discovery: "direct", operations: [] },
    },
  },
};
const P = executionCapabilityPrompt(EXECUTION);
const compose = (context: ReturnType<typeof ctx>, resumed: boolean) =>
  composeTurnPrompt(context, resumed, EXECUTION);

describe("composeTurnPrompt — fresh vs resumed context", () => {
  test("uses the current product brand in model-visible workflow guidance", () => {
    expect(W).toContain("useAgent automations");
    expect(W).not.toContain(`${"Sky"}net automations`);
  });

  test("fresh native session gets operating-rules + bootstrap + turn + prompt, in that order", () => {
    expect(compose(ctx(), false)).toBe(`${R}BOOT${P}${W}${S}TURNUSER`);
  });

  test("resumed session gets current skill discovery + turn + prompt, but not bootstrap history", () => {
    const out = compose(ctx(), true);
    expect(out).toBe(`${P}${W}${S}TURNUSER`);
    expect(out).not.toContain("BOOT"); // native session already holds the thread
    expect(out).not.toContain("operating_rules"); // and already saw the global rules on its first turn
    expect(out).toContain("skills_list");
    expect(out).toContain("skill_activate");
  });

  test("REGRESSION: a resumed session STILL carries fresh turnContext (memory not dropped)", () => {
    // The bug: resumed → only ctx.prompt, so this recalled fact never reached the model.
    expect(compose(ctx({ turnContext: "RECALLED_FACT" }), true)).toContain("RECALLED_FACT");
  });

  test("fresh and resumed turns carry the current server-authored resource snapshot", () => {
    const resourceContext = "<resource_access_snapshot>{}</resource_access_snapshot>";
    expect(compose(ctx({ resourceContext }), false)).toContain(resourceContext);
    expect(compose(ctx({ resourceContext }), true)).toContain(resourceContext);
  });

  test("fresh run ALWAYS carries the operating rules (graceful-degradation guardrail)", () => {
    const bare = ctx({ bootstrapContext: "", turnContext: "" });
    expect(compose(bare, false)).toBe(`${R}${P}${W}${S}USER`);
    expect(compose(bare, false)).toContain("operating_rules");
    // resumed stays lean but still receives current catalog-discovery guidance.
    expect(compose(bare, true)).toBe(`${P}${W}${S}USER`);
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
    expect(compose(ctx({ bootstrapContext: "" }), false)).toBe(
      `${R}${P}${W}${S}TURNUSER`,
    );
  });

  test("pinned skill context governs without forcing catalog discovery again", () => {
    const out = compose(ctx({ skillContext: "PINNED_SKILL\n" }), true);
    expect(out).toBe(`${P}${W}PINNED_SKILL\nTURNUSER`);
    expect(out).not.toContain("<skill_discovery>");
    expect(out).toContain("automation_create");
  });

  test("fresh catalog metadata supplements model-side skill discovery", () => {
    const catalog = "<skill_catalog>\nCATALOG_JSON\n</skill_catalog>\n\n";
    const out = compose(ctx({ skillCatalogContext: catalog }), false);
    expect(out).toBe(`${R}BOOT${P}${W}${S}${catalog}TURNUSER`);
    expect(out).toContain("skills_list");
    expect(out).toContain("skill_activate");
    expect(out).toContain("automation_create");
  });

  test("resumed catalog metadata does not suppress model-side skill discovery", () => {
    const catalog = "<skill_catalog>\nCATALOG_JSON\n</skill_catalog>\n\n";
    const out = compose(ctx({ skillCatalogContext: catalog }), true);
    expect(out).toBe(`${P}${W}${S}${catalog}TURNUSER`);
    expect(out).toContain("skills_list");
    expect(out).toContain("skill_activate");
    expect(out).toContain("automation_create");
  });

  test("pinned skill takes precedence over catalog metadata", () => {
    const out = compose(
      ctx({ skillContext: "PINNED_SKILL\n", skillCatalogContext: "CATALOG\n" }),
      true,
    );
    expect(out).toBe(`${P}${W}PINNED_SKILL\nTURNUSER`);
    expect(out).not.toContain("CATALOG");
  });

  // A VALIDATED native command (commandName set; prompt already the exact `/name args` bytes)
  // is delivered BYTE-VERBATIM. Crucially the discriminator is the VALIDATED commandName, NOT
  // the leading "/", so arbitrary slash-prefixed text can never silently bypass the context.
  describe("validated native command is delivered byte-verbatim", () => {
    test("a fresh validated command turn skips ALL prefixes (rules/bootstrap/skill/memory)", () => {
      const out = compose(
        ctx({
          prompt: "/review src/app.ts",
          commandName: "review",
          skillContext: "SKILL",
          skillCatalogContext: "CATALOG",
          resourceContext: "RESOURCE",
        }),
        false,
      );
      expect(out).toBe("/review src/app.ts");
      expect(out).not.toContain("operating_rules");
      expect(out).not.toContain("BOOT");
      expect(out).not.toContain("SKILL");
      expect(out).not.toContain("CATALOG");
      expect(out).not.toContain("RESOURCE");
      expect(out).not.toContain("TURN");
    });

    test("a resumed validated command turn is verbatim too (no turnContext prepended)", () => {
      expect(compose(ctx({ prompt: "/status", commandName: "status" }), true)).toBe("/status");
    });

    test("SECURITY: a raw prompt that starts with '/' but is NOT a validated command keeps the FULL prefix", () => {
      // The old code skipped context for ANY leading-slash prompt; now only commandName does.
      const out = compose(ctx({ prompt: "/etc/passwd please read this", commandName: null }), false);
      expect(out).toBe(`${R}BOOT${P}${W}${S}TURN/etc/passwd please read this`);
    });

    test("SECURITY: leading whitespace + slash without a validated command still gets the prefix", () => {
      const out = compose(ctx({ prompt: "  /deploy prod" }), false);
      expect(out).toBe(`${R}BOOT${P}${W}${S}TURN  /deploy prod`);
    });

    test("a prompt that only MENTIONS a slash mid-sentence is NOT a command (keeps the prefix)", () => {
      const out = compose(ctx({ prompt: "run the /review command please" }), false);
      expect(out).toBe(`${R}BOOT${P}${W}${S}TURNrun the /review command please`);
    });
  });
});
