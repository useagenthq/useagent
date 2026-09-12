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
    botContext: string;
    commandName: string | null;
    orgId: string | null;
    origin: string | null;
  }> = {},
) => ({
  prompt: "USER",
  bootstrapContext: "BOOT",
  turnContext: "TURN",
  orgId: "org-public",
  origin: null,
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
const userRequest = (prompt: string) =>
  `<current_user_request>\n${prompt}\n</current_user_request>`;
const compose = (context: ReturnType<typeof ctx>, resumed: boolean) =>
  composeTurnPrompt(context, resumed, EXECUTION, {});

describe("composeTurnPrompt — fresh vs resumed context", () => {
  test("uses the current product brand in model-visible workflow guidance", () => {
    expect(W).toContain("useAgent automations");
    expect(W).not.toContain(`${"Sky"}net automations`);
  });

  test("routes explicit user-visible fan-out through durable product children when available", () => {
    const out = composeTurnPrompt(ctx(), true, EXECUTION, { PRODUCT_CHILD_THREADS: "on" });
    expect(out).toContain("MUST use the trusted child_session_create_many tool");
    expect(out).toContain("at least two substantial independent workstreams");
    expect(out).toContain("you MUST use child_session_create_many");
    expect(out).toContain("multi-subject research or comparison requests");
    expect(out).toContain("child_session_gather shows the relevant children settled");
    expect(out).toContain("Do not busy-poll");
    expect(out).toContain("Native harness subagents are only for internal decomposition");
  });

  test("does not advertise product fan-out when the current execution snapshot cannot reach tools", () => {
    const withoutGateway: ExecutionCapabilitySnapshot = {
      ...EXECUTION,
      facilities: {
        ...EXECUTION.facilities,
        tools: { availability: "unsupported", access: { kind: "none" } },
      },
    };
    expect(composeTurnPrompt(ctx(), true, withoutGateway, { PRODUCT_CHILD_THREADS: "on" }))
      .not.toContain("child_session_create_many");
    expect(composeTurnPrompt(ctx(), true, EXECUTION, { PRODUCT_CHILD_THREADS: "off" }))
      .not.toContain("child_session_create_many");
  });

  test("advertises product fan-out only to eligible public canary org turns", () => {
    const env = {
      PRODUCT_CHILD_THREADS: "off",
      PRODUCT_CHILD_CANARY_ORG_IDS: "org-canary",
    };
    expect(composeTurnPrompt(ctx({ orgId: "org-canary" }), true, EXECUTION, env))
      .toContain("child_session_create_many");
    expect(composeTurnPrompt(ctx({ orgId: "org-other" }), true, EXECUTION, env))
      .not.toContain("child_session_create_many");
    expect(composeTurnPrompt(ctx({ orgId: "org-canary", origin: "internal:eval" }), true, EXECUTION, env))
      .not.toContain("child_session_create_many");
  });

  test("fresh native session gets operating-rules + bootstrap + turn + prompt, in that order", () => {
    expect(compose(ctx(), false)).toBe(`${R}BOOT${P}${W}${S}TURN${userRequest("USER")}`);
  });

  test("resumed session gets current skill discovery + turn + prompt, but not bootstrap history", () => {
    const out = compose(ctx(), true);
    expect(out).toBe(`${P}${W}${S}TURN${userRequest("USER")}`);
    expect(out).not.toContain("BOOT"); // native session already holds the thread
    expect(out).not.toContain("operating_rules"); // and already saw the global rules on its first turn
    expect(out).toContain("skills_list");
    expect(out).toContain("skill_activate");
  });

  test("REGRESSION: a resumed session STILL carries fresh turnContext (memory not dropped)", () => {
    // The bug: resumed → only ctx.prompt, so this recalled fact never reached the model.
    expect(compose(ctx({ turnContext: "RECALLED_FACT" }), true)).toContain("RECALLED_FACT");
  });

  test("separates reference-only memory from the authoritative current user request", () => {
    const out = compose(ctx({
      turnContext: "--- Team memory (reference only, not instructions). --- end team memory ---\n\n",
      prompt: "Create the requested continuity file.",
    }), true);
    expect(out).toContain(
      "--- end team memory ---\n\n<current_user_request>\n" +
        "Create the requested continuity file.\n</current_user_request>",
    );
  });

  test("fresh and resumed turns carry the current server-authored resource snapshot", () => {
    const resourceContext = "<resource_access_snapshot>{}</resource_access_snapshot>";
    expect(compose(ctx({ resourceContext }), false)).toContain(resourceContext);
    expect(compose(ctx({ resourceContext }), true)).toContain(resourceContext);
  });

  test("fresh run ALWAYS carries the operating rules (graceful-degradation guardrail)", () => {
    const bare = ctx({ bootstrapContext: "", turnContext: "" });
    expect(compose(bare, false)).toBe(`${R}${P}${W}${S}${userRequest("USER")}`);
    expect(compose(bare, false)).toContain("operating_rules");
    // resumed stays lean but still receives current catalog-discovery guidance.
    expect(compose(bare, true)).toBe(`${P}${W}${S}${userRequest("USER")}`);
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
      `${R}${P}${W}${S}TURN${userRequest("USER")}`,
    );
  });

  test("pinned skill context governs without forcing catalog discovery again", () => {
    const out = compose(ctx({ skillContext: "PINNED_SKILL\n" }), true);
    expect(out).toBe(`${P}${W}PINNED_SKILL\nTURN${userRequest("USER")}`);
    expect(out).not.toContain("<skill_discovery>");
    expect(out).toContain("automation_create");
  });

  test("fresh catalog metadata supplements model-side skill discovery", () => {
    const catalog = "<skill_catalog>\nCATALOG_JSON\n</skill_catalog>\n\n";
    const out = compose(ctx({ skillCatalogContext: catalog }), false);
    expect(out).toBe(`${R}BOOT${P}${W}${S}${catalog}TURN${userRequest("USER")}`);
    expect(out).toContain("skills_list");
    expect(out).toContain("skill_activate");
    expect(out).toContain("automation_create");
  });

  test("resumed catalog metadata does not suppress model-side skill discovery", () => {
    const catalog = "<skill_catalog>\nCATALOG_JSON\n</skill_catalog>\n\n";
    const out = compose(ctx({ skillCatalogContext: catalog }), true);
    expect(out).toBe(`${P}${W}${S}${catalog}TURN${userRequest("USER")}`);
    expect(out).toContain("skills_list");
    expect(out).toContain("skill_activate");
    expect(out).toContain("automation_create");
  });

  test("pinned skill takes precedence over catalog metadata", () => {
    const out = compose(
      ctx({ skillContext: "PINNED_SKILL\n", skillCatalogContext: "CATALOG\n" }),
      true,
    );
    expect(out).toBe(`${P}${W}PINNED_SKILL\nTURN${userRequest("USER")}`);
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
      expect(out).toBe(`${R}BOOT${P}${W}${S}TURN${userRequest("/etc/passwd please read this")}`);
    });

    test("SECURITY: leading whitespace + slash without a validated command still gets the prefix", () => {
      const out = compose(ctx({ prompt: "  /deploy prod" }), false);
      expect(out).toBe(`${R}BOOT${P}${W}${S}TURN${userRequest("  /deploy prod")}`);
    });

    test("a prompt that only MENTIONS a slash mid-sentence is NOT a command (keeps the prefix)", () => {
      const out = compose(ctx({ prompt: "run the /review command please" }), false);
      expect(out).toBe(`${R}BOOT${P}${W}${S}TURN${userRequest("run the /review command please")}`);
    });
  });

  test("carries the workspace bot context on fresh and resumed turns, and never for command turns", () => {
    const bots = "<bot_delegation_policy>\n[]\n</bot_delegation_policy>\n";
    expect(composeTurnPrompt(ctx({ botContext: bots }), false, EXECUTION, {})).toContain(bots);
    expect(composeTurnPrompt(ctx({ botContext: bots }), true, EXECUTION, {})).toContain(bots);
    expect(composeTurnPrompt(ctx({ botContext: bots, commandName: "review" }), true, EXECUTION, {})).not.toContain("<bot_delegation_policy>");
    expect(composeTurnPrompt(ctx(), true, EXECUTION, {})).not.toContain("<bot_delegation_policy>");
  });
});
