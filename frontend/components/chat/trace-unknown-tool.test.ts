import { describe, expect, test } from "bun:test";
import { type ApiStep, deriveTrace } from "./types";

// deriveTrace must render an uncatalogued tool (an MCP tool, `todowrite`, a future
// provider extension) as a generic labelled row from its native payload — never
// mislabel it as a shell "Run" with a terminal glyph.
function commandStep(tool: string, input: Record<string, unknown>, server?: string): ApiStep {
  return {
    id: "s1",
    run_id: "r1",
    idx: 0,
    kind: "command",
    chip: null,
    label: tool,
    code_json: JSON.stringify({
      tool,
      ...(server ? { server } : {}),
      input,
      output: "done",
      native: { sessionID: "ses_x" },
    }),
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
}

describe("deriveTrace — uncatalogued tool", () => {
  test("humanises the tool name and uses the generic (non-shell) glyph", () => {
    const trace = deriveTrace(commandStep("todowrite", { todos: [] }));
    expect(trace.verb).toBe("Todowrite");
    expect(trace.glyph).toBe("task");
    expect(trace.detail).toBe("done"); // output still expandable
  });

  test("strips the mcp namespace to the leaf method", () => {
    const trace = deriveTrace(commandStep("mcp__github__create_issue", { title: "x" }));
    expect(trace.verb).toBe("Create issue");
    expect(trace.glyph).toBe("task");
  });

  test("presents the product name instead of the internal gateway id", () => {
    const step = commandStep("computer_screenshot", {});
    step.code_json = JSON.stringify({
      tool: "computer_screenshot",
      server: "skynet-knowledge",
      input: {},
      output: "done",
    });
    expect(deriveTrace(step)).toMatchObject({
      verb: "Computer screenshot",
      target: "useAgent",
      glyph: "task",
    });
  });

  test("a catalogued shell tool is unaffected (still Run/terminal)", () => {
    const trace = deriveTrace(commandStep("bash", { command: "ls -la" }));
    expect(trace.verb).toBe("Run");
    expect(trace.glyph).toBe("run");
  });

  test("shows the gateway provider as its product name, not the wire id", () => {
    // Gateway tools are tagged server "skynet-knowledge" (the coupled wire name);
    // the attribution label reads as "useAgent" while the wire value stays put.
    const trace = deriveTrace(
      commandStep("mcp__skynet-knowledge__skill_activate", { name: "fast-installs" }, "skynet-knowledge"),
    );
    expect(trace.verb).toBe("Skill activate");
    expect(trace.target).toBe("useAgent");
  });

  test("a genuine MCP server is attributed as-is", () => {
    const trace = deriveTrace(
      commandStep("mcp__github__create_issue", { title: "x" }, "github"),
    );
    expect(trace.verb).toBe("Create issue");
    expect(trace.target).toBe("github");
  });
});
