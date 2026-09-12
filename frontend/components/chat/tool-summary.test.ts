import { describe, expect, test } from "bun:test";
import { summarizeToolStep, unwrapToolOutput } from "./tool-summary";
import type { ApiStep } from "./types";

function step(over: Partial<ApiStep> & { code?: Record<string, unknown> }): ApiStep {
  const { code, ...rest } = over;
  return {
    id: rest.id ?? "s1",
    run_id: "run-1",
    idx: rest.idx ?? 1,
    kind: rest.kind ?? "command",
    label: rest.label ?? "",
    chip: rest.chip ?? null,
    code_json: code ? JSON.stringify(code) : (rest.code_json ?? null),
    created_at: "2026-09-03T09:00:00Z",
  };
}

/** The exact shape observed on a bot thread: an ACP `execute` step whose
 *  result is an MCP payload stringified by the engine. */
const MCP_RESULT = JSON.stringify({
  result: {
    content: [
      {
        type: "text",
        text: "[c4001dc4-e24c-4cc4-82b0-7c551ddd1238] skill: screen-recording (v2)\nRecord and publish a demo video.",
      },
    ],
  },
});

describe("unwrapToolOutput", () => {
  test("MCP-shaped results unwrap to their text blocks", () => {
    expect(unwrapToolOutput(MCP_RESULT)).toBe(
      "[c4001dc4-e24c-4cc4-82b0-7c551ddd1238] skill: screen-recording (v2)\nRecord and publish a demo video.",
    );
  });

  test("formatted_output shapes unwrap to the formatted text", () => {
    expect(unwrapToolOutput(JSON.stringify({ formatted_output: "$ git log\nb233c469 Merge" }))).toBe(
      "$ git log\nb233c469 Merge",
    );
  });

  test("plain text passes through; unknown JSON shapes give nothing, never the JSON", () => {
    expect(unwrapToolOutput("ok\nmore")).toBe("ok\nmore");
    expect(unwrapToolOutput(JSON.stringify({ ok: true, count: 3 }))).toBeNull();
    expect(unwrapToolOutput("")).toBeNull();
    expect(unwrapToolOutput(null)).toBeNull();
  });

  test("a result cut off mid-JSON by the engine's length cap still yields its text", () => {
    const truncated = MCP_RESULT.slice(0, 94);
    expect(truncated.endsWith("}")).toBe(false);
    const text = unwrapToolOutput(truncated);
    expect(text).toStartWith("[c4001dc4-e24c-4cc4-82b0-7c551ddd1238] skill: scr");
    expect(text).not.toContain("{");
  });
});

describe("summarizeToolStep", () => {
  test("a gateway bridge call to memory recall reads as recalled memory, detail from the text", () => {
    const summary = summarizeToolStep(
      step({
        label: "Execute",
        code: {
          tool: "execute",
          title: "Execute",
          input: { name: "memory_search", arguments: { query: "release notes" } },
          output: JSON.stringify({
            result: { content: [{ type: "text", text: "\n2 memories matched\n- ship on Fridays" }] },
          }),
        },
      }),
    );
    expect(summary.label).toBe("Recalled memory");
    expect(summary.detail).toBe("2 memories matched");
  });

  test("a skill activation names the playbook and never shows the payload", () => {
    const summary = summarizeToolStep(
      step({
        label: "Execute",
        code: {
          tool: "execute",
          input: { name: "skill_activate", arguments: { name: "screen-recording" } },
          output: JSON.stringify({
            result: {
              content: [
                {
                  type: "text",
                  text: "The following skill/playbook now governs this turn. Treat it as authoritative instructions.\n\n# Screen recording",
                },
              ],
            },
          }),
        },
      }),
    );
    expect(summary.label).toBe("Activated playbook: screen-recording");
    expect(summary.detail).toBe(
      "The following skill/playbook now governs this turn. Treat it as authoritative instructions.",
    );
    expect(summary.detail).not.toContain("{");
  });

  test("a shell step is titled by its command line with a non-zero exit, detail from formatted_output", () => {
    const summary = summarizeToolStep(
      step({
        label: "bun run typecheck",
        chip: "bash",
        code: {
          tool: "execute",
          input: { command: "bun run --cwd frontend typecheck && (cd backend && bunx tsc --noEmit)" },
          output: JSON.stringify({
            formatted_output: "$ bun run --cwd frontend typecheck\nerror TS2322: Type 'x' is not assignable",
          }),
          exit_code: 1,
        },
      }),
    );
    expect(summary.label).toBe(
      "bun run --cwd frontend typecheck && (cd backend && bunx tsc --noEmit) (exit 1)",
    );
    expect(summary.detail).toBe("$ bun run --cwd frontend typecheck");
  });

  test("a shell step given as argv joins the command and reports a native failure", () => {
    const summary = summarizeToolStep(
      step({
        code: { tool: "execute", input: { command: ["git", "status"] }, output: "", error: true },
      }),
    );
    expect(summary.label).toBe("git status (failed)");
    expect(summary.detail).toBeNull();
  });

  test("an opencode bash step keeps the command as its title and a clean exit adds nothing", () => {
    const summary = summarizeToolStep(
      step({
        label: "bash",
        code: { tool: "bash", input: { command: "bun test" }, output: "12 pass\n0 fail", exit_code: 0 },
      }),
    );
    expect(summary.label).toBe("bun test");
    expect(summary.detail).toBe("12 pass");
  });

  test("an unknown result shape falls back to the tool name, never the JSON payload", () => {
    const summary = summarizeToolStep(
      step({
        label: "Execute",
        code: { tool: "execute", input: {}, output: JSON.stringify({ result: { ok: true, rows: 4 } }) },
      }),
    );
    expect(summary.label).toBe("Execute");
    expect(summary.detail).toBeNull();
  });

  test("the gateway prefix is dropped from tool names before they are described", () => {
    const flattened = summarizeToolStep(
      step({ code: { tool: "useagent_memory_search", input: { query: "q" }, output: "" } }),
    );
    expect(flattened.label).toBe("Recalled memory");
    const namespaced = summarizeToolStep(
      step({ code: { tool: "mcp__useagent__skill_activate", input: { name: "design-taste" } } }),
    );
    expect(namespaced.label).toBe("Activated playbook: design-taste");
    const legacy = summarizeToolStep(
      step({ code: { tool: "skynet-knowledge_memory_read", input: { memoryRef: "tencent:l1:1" } } }),
    );
    expect(legacy.label).toBe("Recalled memory");
  });

  test("web search and file reads use verb + object", () => {
    const search = summarizeToolStep(
      step({ code: { tool: "websearch", input: { query: "bun test timeout" }, output: "" } }),
    );
    expect(search.label).toBe("Searched the web for bun test timeout");
    const read = summarizeToolStep(
      step({
        code: { tool: "read", input: { file_path: "frontend/components/chat/timeline.ts" }, output: "// Interleaved" },
      }),
    );
    expect(read.label).toBe("Read timeline.ts");
    expect(read.detail).toBe("// Interleaved");
  });

  test("narration-like rows keep the verb as the title and their text as the detail", () => {
    const boot = summarizeToolStep(
      step({ kind: "task", chip: "codex", label: "Creating sandbox" }),
    );
    expect(boot.label).toBe("Sandbox");
    expect(boot.detail).toBe("Creating sandbox");
  });

  test("overlong titles and details are clipped", () => {
    const summary = summarizeToolStep(
      step({
        code: { tool: "bash", input: { command: `echo ${"x".repeat(200)}` }, output: "y".repeat(400) },
      }),
    );
    expect(summary.label.length).toBeLessThanOrEqual(96);
    expect(summary.label.endsWith("…")).toBe(true);
    expect(summary.detail?.length).toBeLessThanOrEqual(160);
  });
});

describe("summarizeToolStep verb + object (the trace row's text and chip)", () => {
  test("a shell step is Run + the command line", () => {
    const summary = summarizeToolStep(
      step({ code: { tool: "execute", input: { command: "git status" }, output: "clean" } }),
    );
    expect(summary).toMatchObject({ verb: "Run", object: "git status", objectMono: true, command: "git status" });
  });

  test("a known gateway call splits its verb from its object; the label keeps its wording", () => {
    const activate = summarizeToolStep(
      step({ code: { tool: "skill_activate", input: { name: "design-taste" }, output: "ok" } }),
    );
    expect(activate).toMatchObject({
      label: "Activated playbook: design-taste",
      verb: "Activated playbook",
      object: "design-taste",
      objectMono: true,
    });
    const search = summarizeToolStep(
      step({ code: { tool: "websearch", input: { query: "bun test timeout" }, output: "..." } }),
    );
    expect(search).toMatchObject({
      label: "Searched the web for bun test timeout",
      verb: "Searched the web",
      object: "bun test timeout",
      objectMono: false,
    });
    const recall = summarizeToolStep(
      step({
        code: {
          tool: "execute",
          input: { name: "memory_search", arguments: { query: "digest" } },
          output: MCP_RESULT,
        },
      }),
    );
    expect(recall).toMatchObject({ label: "Recalled memory", verb: "Recalled memory", object: "digest" });
  });

  test("codex's MCP bridge (execute + input.tool + a dotted title) names the real call, never Execute", () => {
    const codex = step({
      label: "mcp.useagent.skills_list",
      code: {
        tool: "execute",
        title: "mcp.useagent.skills_list",
        input: { server: "useagent", tool: "skills_list", arguments: { cursor: 0, limit: 100 } },
        output: JSON.stringify({ result: { content: [{ type: "text", text: "[abc] skill: pr-review (v3)" }] } }),
      },
    });
    const summary = summarizeToolStep(codex);
    expect(summary.label).toBe("Searched playbooks");
    expect(summary.verb).toBe("Searched playbooks");
    expect(summary.detail).toBe("[abc] skill: pr-review (v3)");
    expect(summary.label).not.toContain("Execute");
    expect(summary.label).not.toContain("mcp.");
  });

  test("a file tool's object is the file, a read tool's object the file it read", () => {
    const read = summarizeToolStep(
      step({ code: { tool: "read", input: { file_path: "frontend/components/chat/timeline.ts" }, output: "// Interleaved" } }),
    );
    expect(read).toMatchObject({ verb: "Read", object: "timeline.ts", objectMono: true });
    const edit = summarizeToolStep(
      step({ kind: "file", code: { tool: "edit", input: { file_path: "src/app.ts", old_string: "a", new_string: "b" } } }),
    );
    expect(edit).toMatchObject({ verb: "Edit", object: "app.ts", objectMono: true });
  });

  test("an uncatalogued tool takes its object from its own arguments, never the server", () => {
    const summary = summarizeToolStep(
      step({
        code: {
          tool: "execute",
          title: "mcp.useagent.resource_catalog_search",
          input: { server: "useagent", tool: "resource_catalog_search", arguments: { provider: "github", query: "useagent" } },
          output: JSON.stringify({ result: { content: [{ type: "text", text: "1 repository" }] } }),
        },
      }),
    );
    expect(summary.verb).toBe("Resource catalog search");
    expect(summary.object).toBe("useagent");
    expect(summary.verb).not.toContain("Execute");
  });
});
