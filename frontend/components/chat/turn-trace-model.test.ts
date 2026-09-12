import { describe, expect, test } from "bun:test";
import type { TimelineNode } from "./timeline";
import {
  latestPlanEntries,
  splitTurn,
  traceFailureCount,
  traceHeader,
  traceRowsFromWork,
  turnNodesFromSteps,
  withTransientLiveReasoning,
} from "./turn-trace-model";
import type { ApiStep } from "./types";

function toolNode(id: string, code: Record<string, unknown>, createdAt = "2026-09-03T09:00:00Z"): TimelineNode {
  const step: ApiStep = {
    id,
    run_id: "run-1",
    idx: Number(id.slice(-1)),
    kind: "command",
    label: "Execute",
    chip: null,
    code_json: JSON.stringify(code),
    created_at: createdAt,
  };
  return { kind: "tool", key: id, step };
}

const RAW_MCP_RESULT = JSON.stringify({
  result: { content: [{ type: "text", text: "2 memories matched\n- ship on Fridays" }] },
});

const RECALL: TimelineNode = {
  kind: "marker",
  key: "m1",
  marker: { kind: "context", source: "memory", itemCount: 4, query: null },
};
const PLAYBOOK: TimelineNode = {
  kind: "marker",
  key: "m2",
  marker: { kind: "skill", playbook: true, name: "pr-review", version: 3, hash: "abc" },
};
const THOUGHT: TimelineNode = { kind: "reasoning", key: "r1", text: "Check the log first.\n\nThen the diff." };
const NARRATION: TimelineNode = { kind: "text", key: "t1", text: "Looking at today's commits." };
const GIT_LOG = toolNode("s1", { tool: "execute", input: { command: "git log --since=yesterday" }, output: "b233c469 Merge" });
const TYPECHECK = toolNode(
  "s2",
  { tool: "execute", input: { command: "bun run typecheck" }, output: "", error: true },
  "2026-09-03T09:03:12Z",
);
const IMPLICIT_FAILURE = toolNode("s3", {
  tool: "execute",
  input: { command: "cat missing.txt" },
  output: "cat: missing.txt: No such file or directory",
});
const MEMORY_SEARCH = toolNode("s4", {
  tool: "execute",
  input: { name: "memory_search", arguments: { query: "digest" } },
  output: RAW_MCP_RESULT,
});
const REPLY: TimelineNode = { kind: "text", key: "t2", text: "Here is today's digest." };
const ARTIFACT: TimelineNode = {
  kind: "artifact",
  key: "a1",
  artifact: { id: "a1", name: "digest.md", bytes: 10, sha256: "0".repeat(64), contentType: "text/markdown" },
};
const FILE_RECEIPT: TimelineNode = {
  kind: "file",
  key: "f0",
  file: { path: "src/digest.ts", changeType: "edit" },
};
const FOLLOWUPS: TimelineNode = { kind: "followups", key: "f1", suggestions: ["Post it to Slack"] };

const SETTLED = [RECALL, THOUGHT, NARRATION, GIT_LOG, TYPECHECK, REPLY, FILE_RECEIPT, ARTIFACT, FOLLOWUPS];

describe("splitTurn", () => {
  test("a settled turn keeps the last burst as the reply and folds everything before it", () => {
    const { work, reply, tail } = splitTurn(SETTLED, false);
    expect(reply).toBe("Here is today's digest.");
    expect(work.map((n) => n.key)).toEqual(["m1", "r1", "t1", "s1", "s2"]);
    // Deliverables (file receipts, artifacts) and follow-ups close the turn.
    expect(tail.map((n) => n.key)).toEqual(["f0", "a1", "f1"]);
  });

  test("a multipart final reply keeps its complete contiguous text run visible", () => {
    const second = { kind: "text", key: "t3", text: "Second paragraph." } as const;
    const settled = splitTurn([GIT_LOG, REPLY, second, ARTIFACT], false);
    expect(settled.reply).toBe("Here is today's digest.\n\nSecond paragraph.");
    expect(settled.work.map((node) => node.key)).toEqual(["s1"]);

    const live = splitTurn([GIT_LOG, REPLY, second], true);
    expect(live.reply).toBe("Here is today's digest.\n\nSecond paragraph.");
  });

  test("settled text followed by work stays narration and leaves the durable summary to own the reply", () => {
    const { work, reply } = splitTurn([NARRATION, GIT_LOG, REPLY, TYPECHECK], false);
    expect(reply).toBeNull();
    expect(work.map((n) => n.key)).toEqual(["t1", "s1", "t2", "s2"]);
  });

  test("while live, only a burst at the tail is the reply in progress", () => {
    const streaming = splitTurn([RECALL, GIT_LOG, REPLY], true);
    expect(streaming.reply).toBe("Here is today's digest.");
    expect(streaming.work.map((n) => n.key)).toEqual(["m1", "s1"]);

    const midWork = splitTurn([RECALL, NARRATION, GIT_LOG], true);
    expect(midWork.reply).toBeNull();
    expect(midWork.work.map((n) => n.key)).toEqual(["m1", "t1", "s1"]);
  });

  test("a tool-only turn has no reply", () => {
    expect(splitTurn([GIT_LOG, TYPECHECK], false).reply).toBeNull();
  });
});

describe("withTransientLiveReasoning", () => {
  test("adds transient reasoning only while a timeline has no durable prose", () => {
    expect(withTransientLiveReasoning([GIT_LOG], true, "Checking policy.")).toEqual([
      GIT_LOG,
      { kind: "reasoning", key: "transient-live-reasoning", text: "Checking policy." },
    ]);
    expect(withTransientLiveReasoning([GIT_LOG, THOUGHT], true, "Duplicate.")).toEqual([
      GIT_LOG,
      THOUGHT,
    ]);
    expect(withTransientLiveReasoning([GIT_LOG, REPLY], true, "Too late.")).toEqual([
      GIT_LOG,
      REPLY,
    ]);
  });
});

describe("trace rows", () => {
  test("every work node is one short line: verb-first label, the object in a chip, status", () => {
    const rows = traceRowsFromWork([RECALL, PLAYBOOK, THOUGHT, NARRATION, GIT_LOG, TYPECHECK, MEMORY_SEARCH], false);
    expect(rows.map((row) => [row.family, row.label, row.chip?.text ?? null, row.chip?.mono ?? null, row.detail, row.status])).toEqual([
      ["memory", "Recalled memory", null, null, "4 items", "done"],
      ["playbook", "Activated playbook", "pr-review", true, "v3", "done"],
      ["reasoning", "Thought", "Check the log first.", false, null, "done"],
      ["reasoning", "Said", "Looking at today's commits.", false, null, "done"],
      ["shell", "Run", "git log --since=yesterday", true, null, "done"],
      ["shell", "Run", "bun run typecheck", true, null, "failed"],
      ["memory", "Recalled memory", "digest", false, null, "done"],
    ]);
  });

  test("a shell step failing with an exit code carries the code as its detail", () => {
    const exit = toolNode("s9", { tool: "bash", input: { command: "bun test" }, output: "1 fail", exit_code: 1 });
    expect(traceRowsFromWork([exit], false)[0]).toMatchObject({
      family: "shell",
      label: "Run",
      chip: { text: "bun test", mono: true },
      detail: "exit 1",
      status: "failed",
    });
  });

  test("a file edit names the file in the chip and its line delta as the detail", () => {
    const edit = toolNode("s8", {
      tool: "edit",
      input: {
        file_path: "backend/src/provider-gateway/routes.ts",
        old_string: "const retries = 1;",
        new_string: "const retries = 3;\nconst backoffMs = 250;\nconst jitter = true;",
      },
      output: "Edited routes.ts",
    });
    expect(traceRowsFromWork([edit], false)[0]).toMatchObject({
      family: "file-edit",
      label: "Edit",
      chip: { text: "routes.ts", mono: true },
      detail: "+3 -1",
      status: "done",
    });
  });

  test("five sandbox lifecycle steps fold into one boot line", () => {
    const boot = (idx: number, label: string, chip: string) => ({
      kind: "tool" as const,
      key: `b${idx}`,
      step: {
        id: `b${idx}`,
        run_id: "run-1",
        idx,
        kind: "task" as const,
        label,
        chip,
        code_json: null,
        created_at: "2026-09-03T09:00:00Z",
      },
    });
    const steps = [
      boot(0, "Preparing context and runtime…", "boot"),
      boot(1, "Provisioning cloud sandbox…", "codex"),
      boot(2, "Sandbox bx_geyha ready in 6s (4 CPU / 8 GiB)", "codex"),
      boot(3, "Preparing browser, tools, and integrations…", "codex"),
      boot(4, "Running Codex…", "codex"),
    ];
    const settled = traceRowsFromWork([...steps, GIT_LOG], false);
    expect(settled.map((row) => [row.family, row.label, row.detail, row.status])).toEqual([
      ["boot", "Sandbox ready in 6s", "4 CPU / 8 GiB", "done"],
      ["shell", "Run", null, "done"],
    ]);
    // Still booting: the latest stage, running, without its trailing ellipsis.
    const booting = traceRowsFromWork(steps.slice(0, 2), true);
    expect(booting).toHaveLength(1);
    expect(booting[0]).toMatchObject({ family: "boot", label: "Provisioning cloud sandbox", status: "running" });
  });

  test("reasoning folds into its row: the prose is the payload, its first line the chip", () => {
    const [thought] = traceRowsFromWork([THOUGHT], false);
    expect(thought?.body).toEqual({ kind: "prose", text: THOUGHT.text });
    expect(thought?.label).toBe("Thought");
    expect(thought?.chip).toEqual({ text: "Check the log first.", mono: false });
    expect(traceRowsFromWork([THOUGHT], true)[0]?.label).toBe("Thinking");
  });

  test("a tool row keeps its payload behind the row and never in the label", () => {
    const [recall] = traceRowsFromWork([MEMORY_SEARCH], false);
    expect(recall?.label).not.toContain('{"result"');
    expect(recall?.chip?.text).not.toContain('{"result"');
    expect(recall?.body?.kind).toBe("entry");
    const [gitLog] = traceRowsFromWork([GIT_LOG], false);
    expect(gitLog?.body?.kind).toBe("entry");
  });

  test("while live the last node is the running row; a failure is never running", () => {
    const rows = traceRowsFromWork([RECALL, GIT_LOG, MEMORY_SEARCH], true);
    expect(rows.map((row) => row.status)).toEqual(["done", "done", "running"]);
    const failed = traceRowsFromWork([GIT_LOG, TYPECHECK], true);
    expect(failed.at(-1)?.status).toBe("failed");
  });

  test("an implicit failure (error-shaped output) reads as failed", () => {
    const rows = traceRowsFromWork([IMPLICIT_FAILURE], false);
    expect(rows[0]?.status).toBe("failed");
    expect(traceFailureCount(rows)).toBe(1);
  });

  test("a failed memory write is a failed row, never a fake save", () => {
    const rows = traceRowsFromWork(
      [{ kind: "marker", key: "w", marker: { kind: "memory", op: "remember", scope: "org", failed: true, reconciled: false } }],
      false,
    );
    expect(rows[0]).toMatchObject({ family: "memory", label: "Memory not saved", detail: "service unavailable", status: "failed" });
  });

  test("a plan never becomes a step line; it is the checklist beside the trace", () => {
    const plan = toolNode("p1", {
      tool: "todowrite",
      input: { todos: [{ id: "todo-1", content: "Create components", status: "completed" }] },
    });
    expect(traceRowsFromWork([plan], false)).toEqual([]);
    expect(latestPlanEntries([GIT_LOG, plan])).toEqual([
      { id: "todo-1", text: "Create components", status: "completed" },
    ]);
    expect(latestPlanEntries([GIT_LOG])).toBeNull();
  });

  test("a gateway call in flight names the summarizer's line, never the raw tool title", () => {
    const activate = toolNode("k1", {
      tool: "skill_activate",
      input: { name: "design-taste" },
      output: "The following skill now governs this turn. Treat it as authoritative.",
    });
    const rows = traceRowsFromWork([activate], true);
    expect(rows[0]).toMatchObject({
      family: "playbook",
      label: "Activated playbook",
      chip: { text: "design-taste", mono: true },
      status: "running",
    });
    expect(traceHeader({ live: true, rows, work: [activate], durationMs: null })).toEqual({
      label: "Thinking",
      detail: "Activated playbook design-taste",
      failed: false,
    });
  });
});

describe("traceHeader", () => {
  test("settled with reasoning: Thought for the run's duration, the counts as the detail", () => {
    const { work } = splitTurn(SETTLED, false);
    const rows = traceRowsFromWork(work, false);
    expect(traceHeader({ live: false, rows, work, durationMs: 192_000 })).toEqual({
      label: "Thought for 3m 12s, 1 failed",
      detail: "2 tool calls, 1 message",
      failed: true,
    });
  });

  test("settled without reasoning: the counts are the line, the duration the detail", () => {
    const work = [RECALL, GIT_LOG, TYPECHECK];
    const rows = traceRowsFromWork(work, false);
    expect(traceHeader({ live: false, rows, work, durationMs: 192_000 })).toEqual({
      label: "2 tool calls, 1 failed",
      detail: "3m 12s",
      failed: true,
    });
    const single = traceRowsFromWork([GIT_LOG], false);
    expect(traceHeader({ live: false, rows: single, work: [GIT_LOG], durationMs: 1_000 })).toEqual({
      label: "1 tool call",
      detail: "1s",
      failed: false,
    });
  });

  test("settled without a run duration falls back to the steps' own timestamps", () => {
    const { work } = splitTurn(SETTLED, false);
    const rows = traceRowsFromWork(work, false);
    expect(traceHeader({ live: false, rows, work, durationMs: null }).label).toBe(
      "Thought for 3m 12s, 1 failed",
    );
    const recallOnly = traceRowsFromWork([RECALL], false);
    expect(traceHeader({ live: false, rows: recallOnly, work: [RECALL], durationMs: null })).toEqual({
      label: "Context",
      detail: null,
      failed: false,
    });
  });

  test("context and playbook markers never inflate the tool-call count", () => {
    const work = [RECALL, PLAYBOOK];
    const rows = traceRowsFromWork(work, false);
    expect(traceHeader({ live: false, rows, work, durationMs: null })).toEqual({
      label: "Context",
      detail: null,
      failed: false,
    });
  });

  test("a file-receipt-only trace names the file work instead of generic context", () => {
    expect(
      traceHeader({
        live: false,
        rows: [],
        work: [],
        durationMs: null,
        changedFileCount: 2,
      }),
    ).toEqual({ label: "Changed 2 files", detail: null, failed: false });
  });

  test("live: Thinking, with the running step (label + chip) as the detail", () => {
    const work = [RECALL, GIT_LOG, TYPECHECK];
    expect(traceHeader({ live: true, rows: traceRowsFromWork(work, true), work, durationMs: null })).toEqual({
      label: "Thinking",
      detail: null,
      failed: false,
    });
    const running = [GIT_LOG, THOUGHT];
    expect(traceHeader({ live: true, rows: traceRowsFromWork(running, true), work: running, durationMs: null }).detail).toBe(
      "Thinking Check the log first.",
    );
    const command = [RECALL, GIT_LOG];
    expect(traceHeader({ live: true, rows: traceRowsFromWork(command, true), work: command, durationMs: null }).detail).toBe(
      "Run git log --since=yesterday",
    );
  });
});

describe("turnNodesFromSteps (the lane without native frames)", () => {
  const step = (idx: number, kind: ApiStep["kind"], label: string, chip: string | null, code: unknown = null): ApiStep => ({
    id: `st${idx}`,
    run_id: "run-1",
    idx,
    kind,
    label,
    chip,
    code_json: code === null ? null : JSON.stringify(code),
    created_at: "2026-09-03T09:00:00Z",
  });
  const STEPS: ApiStep[] = [
    step(0, "task", "Preparing context and runtime…", "boot", { phase: "preparing" }),
    step(1, "task", "Provisioning cloud sandbox…", "claude"),
    step(2, "task", "Sandbox bx_2gv77 ready in 4s (4 CPU / 8 GiB)", "claude"),
    step(3, "command", "cat hello.txt", "bash", { tool: "bash", input: { command: "cat hello.txt" }, output: "ready" }),
    step(4, "task", "Hey! Scout here — I watch competitors and write the weekly …", "task"),
    step(5, "done", "Done", null),
  ];

  test("settled history keeps the work and drops plumbing, the prose preview and the done step", () => {
    expect(turnNodesFromSteps(STEPS, false).map((node) => node.key)).toEqual(["st3"]);
  });

  test("live keeps the boot steps (they are the signal) but never the prose preview", () => {
    expect(turnNodesFromSteps(STEPS, true).map((node) => node.key)).toEqual(["st0", "st1", "st2", "st3"]);
  });

  test("a chat turn (context preparation only) has no work at all once settled", () => {
    const chat = [
      step(0, "task", "Preparing chat context...", "chat", { phase: "retrieval" }),
      step(1, "done", "Done", null, { citations: [] }),
    ];
    expect(turnNodesFromSteps(chat, false)).toEqual([]);
    expect(traceRowsFromWork(turnNodesFromSteps(chat, true), true)).toMatchObject([
      { family: "boot", label: "Preparing chat context", status: "running" },
    ]);
  });
});
