import { describe, expect, test } from "bun:test";
import {
  buildTimelineFromCanonical,
  type CanonicalEventLike,
} from "@/components/chat/canonical-timeline";
import type { TimelineNode } from "@/components/chat/timeline";
import type { ApiStep } from "@/components/chat/types";
import { segmentTimeline, workEntriesFromTimeline, workEntryFromTimelineNode } from "./adapter";
import {
  toolWorkEntryHeading,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
} from "./work-entry";

function step(over: Partial<ApiStep>): ApiStep {
  return {
    id: over.id ?? "s1",
    run_id: "run-1",
    idx: over.idx ?? 1,
    kind: over.kind ?? "command",
    label: over.label ?? "",
    chip: over.chip ?? null,
    code_json: over.code_json ?? null,
    created_at: "2026-08-17T09:00:00Z",
  };
}

function toolNode(s: ApiStep): TimelineNode {
  return { kind: "tool", key: s.id, step: s };
}

let seq = 0;
function ev(kind: string, body: Record<string, unknown> = {}): CanonicalEventLike {
  seq += 1;
  return { kind, seq, identity: { nativeEventId: `ev-${seq}`, nativeSeq: seq }, ...body };
}

describe("child-session fan-out heading regression (bare chevron+status rows)", () => {
  test("a gateway child_session_create tool step derives its heading from the tool name", () => {
    const nodes = buildTimelineFromCanonical(
      [
        ev("tool.started", {
          toolCallId: "call-spawn",
          name: "child_session_create",
          input: { prompt: "Summarize the wiki", idempotencyKey: "k1" },
        }),
        ev("tool.completed", { toolCallId: "call-spawn", status: "ok", preview: "queued child c1" }),
        ev("child.started", { childId: "c1", launchToolCallId: "call-spawn" }),
      ],
      new Map(),
      false,
    );
    const entries = workEntriesFromTimeline(nodes, false);
    expect(entries).toHaveLength(1);
    expect(toolWorkEntryHeading(entries[0]!)).toBe("Child session create");
    // Settled create call reads success (green check), not failure.
    expect(workEntryIndicatesToolSuccess(entries[0]!)).toBe(true);
    expect(workEntryIndicatesToolFailure(entries[0]!)).toBe(false);
  });

  test("a failed child_session_create call reads failure, never a bare row", () => {
    const nodes = buildTimelineFromCanonical(
      [
        ev("tool.started", {
          toolCallId: "call-bad",
          name: "child_session_create",
          input: { prompt: "x", idempotencyKey: "k2" },
        }),
        ev("tool.completed", {
          toolCallId: "call-bad",
          status: "error",
          error: "child_session_create requires idempotencyKey.",
        }),
      ],
      new Map(),
      false,
    );
    const entries = workEntriesFromTimeline(nodes, false);
    expect(entries).toHaveLength(1);
    expect(toolWorkEntryHeading(entries[0]!).length).toBeGreaterThan(0);
    expect(workEntryIndicatesToolFailure(entries[0]!)).toBe(true);
  });

  test("a bare tool receipt (no name/title, the claude lane's seal shape) still carries a heading", () => {
    const nodes = buildTimelineFromCanonical(
      [
        ev("tool.started", { toolCallId: "call-bare" }),
        ev("tool.completed", { toolCallId: "call-bare", status: "ok", preview: "done" }),
      ],
      new Map(),
      false,
    );
    const entries = workEntriesFromTimeline(nodes, false);
    expect(entries).toHaveLength(1);
    expect(toolWorkEntryHeading(entries[0]!).trim().length).toBeGreaterThan(0);
  });

  test("task-type and label-less steps always produce a non-empty heading", () => {
    const shapes: ApiStep[] = [
      // A task-type step whose ApiStep lacks a friendly label entirely.
      step({ id: "t1", kind: "task", label: "", chip: "task" }),
      // A T3 task lifecycle receipt (source t3, task tool, empty label).
      step({
        id: "t2",
        kind: "task",
        label: "",
        chip: "task.started",
        code_json: JSON.stringify({
          source: "t3",
          activityKind: "task.started",
          tool: "task",
          input: {},
        }),
      }),
      // A command step with no label and no tool identity at all.
      step({ id: "t3", kind: "command", label: "" }),
      // A child_session tool call recorded as a durable step (opencode MCP shape).
      step({
        id: "t4",
        kind: "command",
        label: "",
        code_json: JSON.stringify({
          tool: "skynet-knowledge_child_session_gather",
          input: {},
        }),
      }),
      // A subagent spawn with no description: the prompt still names the child.
      step({
        id: "t5",
        kind: "task",
        label: "",
        chip: "subagent",
        code_json: JSON.stringify({ tool: "task", input: { prompt: "Audit retry budgets" } }),
      }),
    ];
    for (const s of shapes) {
      const entry = workEntryFromTimelineNode(toolNode(s), "done");
      expect(entry).not.toBeNull();
      expect(toolWorkEntryHeading(entry!).trim().length).toBeGreaterThan(0);
    }
  });
});

test("live status keeps only the semantic heading while detail stays in the work entry", () => {
  const projection = segmentTimeline([
    toolNode(step({
      id: "skill-activate",
      label: "Skill activate",
      code_json: JSON.stringify({
        tool: "skill_activate",
        input: { name: "design-taste" },
        output: "The following skill now governs this turn. Treat it as authoritative.",
      }),
    })),
  ], true);

  expect(projection.workingLabel).toBe("Skill activate");
  expect(projection.segments).toHaveLength(1);
});
