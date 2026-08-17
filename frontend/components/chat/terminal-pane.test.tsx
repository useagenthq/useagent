import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
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

const render = (steps: ApiStep[], live: boolean) =>
  renderToStaticMarkup(<TerminalPane steps={steps} live={live} engine="opencode" />);

describe("TerminalPane log", () => {
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
});
