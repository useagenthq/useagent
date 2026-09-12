import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { compressTerminalLog, LOG_BODY_MAX_LINES } from "@/components/chat/terminal-log-model";
import { TerminalPane } from "@/components/chat/terminal-pane";
import type { ApiStep } from "@/components/chat/types";

// The LOG body is what these assert. Rendered WITHOUT a runId so the pane defaults
// to (and pins) the Log tab - the same JSX the "Log" toggle shows in a live session
// (the tab switch is user state, not part of the log render logic).
let seq = 0;
function commandStep(command: string, extra: Record<string, unknown> = {}): ApiStep {
  seq += 1;
  return {
    id: `step-${seq}`,
    run_id: "run-1",
    idx: seq,
    kind: "command",
    label: command,
    chip: "bash",
    code_json: JSON.stringify({ tool: "bash", input: { command }, ...extra }),
    created_at: "2026-08-17T00:00:00.000Z",
  };
}

/** A tool step shaped like the engine records a gateway/MCP call: the tool is
 *  the generic bridge and the real call rides in `input.name`. */
function callStep(name: string, args: Record<string, unknown>, output: unknown): ApiStep {
  seq += 1;
  return {
    id: `step-${seq}`,
    run_id: "run-1",
    idx: seq,
    kind: "command",
    label: "Execute",
    chip: null,
    code_json: JSON.stringify({
      tool: "execute",
      input: { name, arguments: args },
      output: typeof output === "string" ? output : JSON.stringify(output),
    }),
    created_at: "2026-08-17T00:00:00.000Z",
  };
}

const render = (steps: ApiStep[], live: boolean, runId?: string) =>
  renderToStaticMarkup(
    <TerminalPane steps={steps} live={live} engine="opencode" runId={runId} />,
  );

describe("TerminalPane log", () => {
  test("makes the selected Shell tab visibly distinct", () => {
    const html = render([], false, "run-1");
    expect(html).toContain('data-testid="terminal-tab-shell"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("bg-neutral-800");
    expect(html).toContain("ring-white/15");
  });

  test("renders an in-flight command step (no output/exit) with a running caret", () => {
    // opencode emits the `$ command` line at `running`, before output lands - the
    // log must show it immediately, not wait for the step to settle.
    const html = render([commandStep("git clone https://github.com/acme/repo")], true);
    expect(html).toContain("git clone https://github.com/acme/repo");
    expect(html).toContain("ai-caret"); // the running command tails a caret
    // A single in-flight command IS the motion, so no duplicate working footer.
    expect(html).not.toContain("terminal-log-working");
  });

  test("shows a live working footer when the in-flight run has no new command yet", () => {
    // The regression: a live run whose only visible command is a PRIOR settled turn
    // read as a frozen pane. The footer keeps the log visibly moving.
    const settled = commandStep("echo MATRIX_OC_OK", { output: "MATRIX_OC_OK", exit_code: 0 });
    const html = render([settled], true);
    expect(html).toContain("echo MATRIX_OC_OK");
    expect(html).toContain("MATRIX_OC_OK");
    expect(html).toContain("terminal-log-working"); // log visibly moves while live
    expect(html).toContain("agent-progress-loading-text");
  });

  test("streams output onto a command as it settles", () => {
    const done = commandStep("bun test", {
      output: "2 pass 0 fail",
      exit_code: 0,
    });
    const html = render([done], true);
    expect(html).toContain("bun test");
    expect(html).toContain("2 pass 0 fail");
  });

  test("surfaces a non-zero exit for a failed command", () => {
    const failed = commandStep("bun test", { output: "1 fail", exit_code: 1 });
    const html = render([failed], true);
    expect(html).toContain("exit 1");
  });

  test("a settled (not live) thread shows no caret and no working footer", () => {
    const settled = commandStep("echo done", { output: "done", exit_code: 0 });
    const html = render([settled], false);
    expect(html).not.toContain("ai-caret");
    expect(html).not.toContain("terminal-log-working");
  });

  test("empty log reads as booting while live, idle when settled", () => {
    expect(render([], true)).toContain("Booting session");
    expect(render([], false)).toContain("No commands were run.");
    // A boot-phase live run with zero commands does not also show the footer.
    expect(render([], true)).not.toContain("terminal-log-working");
  });

  test("a shell result wrapped as formatted_output shows its text, never the wrapper", () => {
    const wrapped = commandStep("git status", {
      output: JSON.stringify({ formatted_output: "On branch main\nnothing to commit" }),
      exit_code: 0,
    });
    const html = render([wrapped], false);
    expect(html).toContain("$</span>");
    expect(html).toContain("git status");
    expect(html).toContain("On branch main");
    expect(html).toContain("nothing to commit");
    expect(html).not.toContain("formatted_output");
    expect(html).not.toContain("{&quot;");
  });

  test("an MCP-shaped gateway call is one line, with no payload dump", () => {
    const descriptor = "x".repeat(2000);
    const recall = callStep("memory_search", { query: "digest" }, {
      result: { content: [{ type: "text", text: "4 memories matched\n- ship on Fridays" }] },
    });
    const activate = callStep("skill_activate", { name: "pr-review" }, {
      result: { content: [{ type: "text", text: `Playbook pr-review v3\n${descriptor}` }] },
    });
    const html = render([recall, activate], false);
    expect(html).toContain('data-testid="terminal-log-call"');
    expect(html).toContain("recalled memory");
    expect(html).toContain("4 memories matched");
    expect(html).toContain("activated playbook: pr-review");
    expect(html).not.toContain("$ Execute");
    expect(html).not.toContain("ship on Fridays");
    expect(html).not.toContain(descriptor);
    expect(html).not.toContain('{&quot;result&quot;');
    expect(html).not.toContain("content");
  });

  test("a long result is cut to the first lines with a +K lines tail", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const long = commandStep("bun test", { output: lines.join("\n"), exit_code: 0 });
    const html = render([long], false);
    expect(html).toContain(`line ${LOG_BODY_MAX_LINES}`);
    expect(html).not.toContain(`line ${LOG_BODY_MAX_LINES + 1}<`);
    expect(html).toContain(`+${40 - LOG_BODY_MAX_LINES} lines`);
  });

  test("a truncated JSON payload still yields its readable text", () => {
    const cut = `{"result":{"content":[{"type":"text","text":"first line\\nsecond line`;
    const entries = compressTerminalLog([commandStep("cat big.json", { output: cut, exit_code: 0 })]);
    expect(entries[0]).toMatchObject({ kind: "command", lines: ["first line", "second line"], hiddenLines: 0 });
    // A result in an unknown JSON shape renders nothing rather than the JSON.
    const unknown = compressTerminalLog([
      commandStep("curl api", { output: JSON.stringify({ data: { id: 1 } }), exit_code: 0 }),
    ]);
    expect(unknown[0]).toMatchObject({ kind: "command", lines: [], settled: true });
  });
});
