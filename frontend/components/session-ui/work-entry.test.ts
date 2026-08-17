import { describe, expect, test } from "bun:test";
import {
  buildToolCallExpandedBody,
  formatWorkingTimer,
  groupWorkEntryOverflow,
  type WorkEntry,
  toolWorkEntryHeading,
  workEntryIconName,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workEntryPreview,
} from "./work-entry";

const tool = (over: Partial<WorkEntry>): WorkEntry => ({
  id: over.id ?? "e1",
  label: "Run",
  tone: "tool",
  ...over,
});

describe("status heuristics (upstream session-logic parity)", () => {
  test("explicit failed lifecycle status fails the row", () => {
    expect(workEntryIndicatesToolFailure(tool({ toolLifecycleStatus: "failed" }))).toBe(true);
  });

  test("error-shaped output fails the row even when status says completed", () => {
    const entry = tool({
      toolLifecycleStatus: "completed",
      command: "cat missing.txt",
      detail: "cat: missing.txt: No such file or directory",
    });
    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryIndicatesToolSuccess(entry)).toBe(false);
  });

  test("non-zero exit code text is a failure", () => {
    expect(
      workEntryIndicatesToolFailure(tool({ detail: "<exited with exit code 2>" })),
    ).toBe(true);
  });

  test("a settled tool row with clean output reads success", () => {
    const entry = tool({ command: "bun test", detail: "12 pass 0 fail" });
    expect(workEntryIndicatesToolSuccess(entry)).toBe(true);
    expect(workEntryIndicatesToolNeutralStatus(entry)).toBe(false);
  });

  test("in-progress rows are neutral, thinking rows are never success", () => {
    expect(
      workEntryIndicatesToolNeutralStatus(tool({ toolLifecycleStatus: "inProgress" })),
    ).toBe(true);
    expect(
      workEntryIndicatesToolSuccess(tool({ tone: "thinking", detail: "planning" })),
    ).toBe(false);
  });
});

describe("heading + preview grammar", () => {
  test("heading strips trailing 'completed' and capitalizes", () => {
    expect(toolWorkEntryHeading(tool({ label: "grep completed" }))).toBe("Grep");
    expect(toolWorkEntryHeading(tool({ toolTitle: "read file complete" }))).toBe("Read file");
  });

  test("heading is never empty (bare chevron+status row regression)", () => {
    // The exact shapes that used to blank the heading: no label at all, a
    // whitespace label, and a label the compact normalization strips to "".
    expect(toolWorkEntryHeading(tool({ label: "" }))).toBe("Tool");
    expect(toolWorkEntryHeading(tool({ label: "   " }))).toBe("Tool");
    expect(toolWorkEntryHeading(tool({ label: " completed" }))).toBe("Tool");
    expect(toolWorkEntryHeading(tool({ label: "", toolTitle: "  " }))).toBe("Tool");
    // An empty toolTitle falls back to the label instead of blanking the row.
    expect(toolWorkEntryHeading(tool({ label: "Run", toolTitle: " completed" }))).toBe("Run");
    // Structural fallbacks keep child-session/task rows identifiable.
    expect(toolWorkEntryHeading(tool({ label: "", itemType: "dynamic_tool_call" }))).toBe(
      "Tool call",
    );
    expect(toolWorkEntryHeading(tool({ label: "", itemType: "collab_agent_tool_call" }))).toBe(
      "Subagent",
    );
    expect(toolWorkEntryHeading(tool({ label: "", taskId: "task-1" }))).toBe("Subagent");
    expect(toolWorkEntryHeading(tool({ label: "", requestKind: "command" }))).toBe("Run");
    expect(toolWorkEntryHeading(tool({ label: "", tone: "thinking" }))).toBe("Thinking");
  });

  test("preview precedence: command > detail > changed files", () => {
    expect(workEntryPreview(tool({ command: "ls", detail: "out" }), undefined)).toBe("ls");
    expect(workEntryPreview(tool({ detail: "out" }), undefined)).toBe("out");
    expect(
      workEntryPreview(tool({ changedFiles: ["/w/a.ts", "/w/b.ts"] }), "/w"),
    ).toBe("w/a.ts +1 more");
  });

  test("expanded body folds raw command, detail, and files into blocks", () => {
    const body = buildToolCallExpandedBody(
      tool({
        command: "bun test",
        rawCommand: "cd app && bun test",
        detail: "3 pass",
        changedFiles: ["/w/x.ts"],
      }),
      "/w",
    );
    expect(body).toBe("cd app && bun test\n\n3 pass\n\nw/x.ts");
  });
});

describe("icon grammar", () => {
  test("requestKind wins over everything", () => {
    expect(workEntryIconName(tool({ requestKind: "file-read", command: "x" }))).toBe("eye");
    expect(workEntryIconName(tool({ requestKind: "command" }))).toBe("terminal");
  });

  test("itemType and structure fallbacks", () => {
    expect(workEntryIconName(tool({ command: "ls" }))).toBe("terminal");
    expect(workEntryIconName(tool({ changedFiles: ["a"] }))).toBe("square-pen");
    expect(workEntryIconName(tool({ itemType: "web_search" }))).toBe("globe");
    expect(workEntryIconName(tool({ itemType: "mcp_tool_call" }))).toBe("wrench");
    expect(workEntryIconName(tool({ taskId: "t1" }))).toBe("bot");
    expect(workEntryIconName(tool({ tone: "thinking" }))).toBe("bot");
  });
});

describe("work-group overflow policy", () => {
  const entries = [1, 2, 3, 4].map((n) => tool({ id: `e${n}`, command: `cmd-${n}` }));

  test("collapsed keeps the newest maxVisible rows and counts the rest", () => {
    const collapsed = groupWorkEntryOverflow(entries, false, 1);
    expect(collapsed.visible.map((e) => e.id)).toEqual(["e4"]);
    expect(collapsed.hiddenCount).toBe(3);
    expect(collapsed.onlyToolEntries).toBe(true);
  });

  test("expanded shows everything in chronological order", () => {
    const expanded = groupWorkEntryOverflow(entries, true, 1);
    expect(expanded.visible.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(expanded.hiddenCount).toBe(3);
  });

  test("neutral rows are filtered before the fold", () => {
    const withNeutral = [...entries, tool({ id: "e5", toolLifecycleStatus: "inProgress" })];
    const grouped = groupWorkEntryOverflow(withNeutral, false, 1);
    expect(grouped.visible.map((e) => e.id)).toEqual(["e4"]);
    expect(grouped.hiddenCount).toBe(3);
  });

  test("small groups render without a toggle", () => {
    const grouped = groupWorkEntryOverflow(entries.slice(0, 1), false, 1);
    expect(grouped.hiddenCount).toBe(0);
    expect(grouped.visible).toHaveLength(1);
  });
});

describe("working timer format", () => {
  test("seconds, minutes, hours", () => {
    expect(formatWorkingTimer("2026-01-01T00:00:00Z", "2026-01-01T00:00:42Z")).toBe("42s");
    expect(formatWorkingTimer("2026-01-01T00:00:00Z", "2026-01-01T00:02:05Z")).toBe("2m 5s");
    expect(formatWorkingTimer("2026-01-01T00:00:00Z", "2026-01-01T01:30:00Z")).toBe("1h 30m");
    expect(formatWorkingTimer("bad", "2026-01-01T00:00:00Z")).toBeNull();
  });
});
