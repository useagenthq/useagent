import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { workEntriesFromTimeline } from "@/components/session-ui/adapter";
import {
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
} from "@/components/session-ui/work-entry";
import { commandFailedWithRun } from "./command-failed-with-run";
import { Timeline } from "./timeline-view";
import { traceRowsFromWork, turnNodesFromSteps } from "./turn-trace-model";
import type { ApiStep } from "./types";

function step(
  idx: number,
  kind: ApiStep["kind"],
  label: string,
  chip: string | null,
  code: unknown = null,
): ApiStep {
  return {
    id: `st${idx}`,
    run_id: "run-synthetic-clone-failure",
    idx,
    kind,
    label,
    chip,
    code_json: code === null ? null : JSON.stringify(code),
    created_at: `2030-01-01T00:00:0${idx}.000Z`,
  };
}

// Synthetic regression: repo preparation emitted its "Cloning" command step,
// the clone script was refused, and the failure landed only on the run. The
// command step itself carries no payload at all.
const CLONING = step(5, "command", "Cloning example/widgets", "git");
const ENGINE_ERROR = step(6, "done", "Engine error", null);
const CLONE_REFUSED: ApiStep[] = [
  step(0, "task", "Preparing context and runtime…", "boot", { phase: "preparing" }),
  step(1, "task", "Provisioning cloud sandbox…", "opencode"),
  step(2, "task", "Sandbox sandbox-demo-01 ready in 10s (4 CPU / 8 GiB)", "opencode"),
  step(3, "task", "Preparing browser, tools, and integrations…", "opencode"),
  step(4, "task", "Starting agent runtime…", "opencode"),
  CLONING,
  ENGINE_ERROR,
];

describe("a command step the run's failure cut short", () => {
  test("the refused clone renders as failed in the turn trace, never a green check", () => {
    const nodes = turnNodesFromSteps(CLONE_REFUSED, false, "failed");
    expect(nodes.map((node) => node.key)).toEqual(["st5"]);
    expect(traceRowsFromWork(nodes, false)).toMatchObject([{ status: "failed" }]);

    const html = renderToStaticMarkup(
      <Timeline nodes={nodes} live={false} trace={{ durationMs: 31_605, defaultOpen: true }} />,
    );
    expect(html).toContain("1 tool call, 1 failed");
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('aria-label="Failed"');
    expect(html).not.toContain('aria-label="Completed"');
  });

  test("the folded work-entry lane reads the same failure", () => {
    const entries = workEntriesFromTimeline(
      turnNodesFromSteps(CLONE_REFUSED, false, "failed"),
      false,
    );
    expect(
      entries.map((entry) => [
        entry.toolLifecycleStatus,
        workEntryIndicatesToolFailure(entry),
        workEntryIndicatesToolSuccess(entry),
      ]),
    ).toEqual([["failed", true, false]]);
  });
});

describe("commandFailedWithRun", () => {
  test("names the trailing command of an engine-error run", () => {
    expect(commandFailedWithRun(CLONE_REFUSED, "failed")).toBe(CLONING);
  });

  test("the done step is enough while the run status has not settled yet", () => {
    expect(commandFailedWithRun([CLONING, ENGINE_ERROR], "running")).toBe(CLONING);
  });

  test("a failed run with no done step still fails its trailing command", () => {
    expect(commandFailedWithRun([CLONING], "failed")).toBe(CLONING);
  });

  test("a completed run leaves its last command alone", () => {
    const done = step(6, "done", "Done", null);
    expect(commandFailedWithRun([CLONING, done], "completed")).toBeNull();
    expect(commandFailedWithRun([CLONING], "running")).toBeNull();
  });

  test("a command that recorded its own outcome keeps it when the engine fails afterwards", () => {
    const finished = step(5, "command", "mkdir out", "bash", {
      tool: "bash",
      input: { command: "mkdir out" },
      output: "",
      error: false,
    });
    expect(commandFailedWithRun([finished, ENGINE_ERROR], "failed")).toBeNull();
  });

  test("nothing to blame when the run failed after the command was over", () => {
    const preview = step(6, "task", "Cloned the repository, listing its top-level…", "task");
    expect(commandFailedWithRun([CLONING, preview, ENGINE_ERROR], "failed")).toBeNull();
  });
});
