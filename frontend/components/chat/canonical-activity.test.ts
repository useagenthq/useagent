import { describe, expect, test } from "bun:test";
import { buildTimelineFromCanonical, type CanonicalEventLike } from "./canonical-timeline";
import { type ApiStep, deriveTrace, isRenderableTimelineStep, parseTodos } from "./types";

function event(kind: string, seq: number, body: Record<string, unknown> = {}): CanonicalEventLike {
  return {
    kind,
    seq,
    identity: { nativeEventId: `event-${seq}`, nativeSeq: seq },
    ...body,
  } as unknown as CanonicalEventLike;
}

function onlyTool(events: readonly CanonicalEventLike[]): ApiStep {
  const nodes = buildTimelineFromCanonical(events, new Map(), false);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]?.kind).toBe("tool");
  return (nodes[0] as Extract<(typeof nodes)[number], { kind: "tool" }>).step;
}

describe("canonical activity projection", () => {
  test("filters empty T3 MCP transport wrappers from legacy step timelines", () => {
    const wrapper: ApiStep = {
      id: "st_transport",
      run_id: "run-1",
      idx: 1,
      kind: "command",
      label: "Mcp tool call",
      chip: "tool.completed",
      code_json: JSON.stringify({
        source: "t3",
        activityId: "act-1",
        activityKind: "tool.completed",
        tool: "mcp_tool_call",
        input: {},
        native: { activity: { itemType: "mcp_tool_call" } },
      }),
      created_at: new Date(0).toISOString(),
    };
    const semantic: ApiStep = {
      ...wrapper,
      id: "st_semantic",
      label: "github · create_issue",
      code_json: JSON.stringify({
        source: "t3",
        activityId: "act-2",
        activityKind: "tool.completed",
        tool: "create_issue",
        server: "github",
        input: { title: "checkout regression" },
        output: "created issue #42",
        native: { activity: { itemType: "mcp_tool_call" } },
      }),
    };

    expect(isRenderableTimelineStep(wrapper)).toBe(false);
    expect(isRenderableTimelineStep(semantic)).toBe(true);
  });

  test("folds a tool lifecycle into one truthful row without a legacy sidecar", () => {
    const projected = onlyTool([
      event("tool.started", 1, {
        toolCallId: "call-1",
        name: "mcp__github__create_issue",
        title: "Create issue",
        input: { name: "checkout regression" },
      }),
      event("tool.progress", 2, {
        toolCallId: "call-1",
        preview: "creating issue",
      }),
      event("tool.completed", 3, {
        toolCallId: "call-1",
        status: "ok",
        preview: "created issue #42",
      }),
    ]);

    const trace = deriveTrace(projected);
    expect(trace.verb).toBe("Create issue");
    expect(trace.target).toBe("checkout regression");
    expect(trace.detail).toBe("created issue #42");
    expect(trace.isError).toBe(false);
  });

  test("renders only the latest plan snapshot through the shared todo grammar", () => {
    const projected = onlyTool([
      event("plan.updated", 1, {
        entries: [{ id: "inspect", text: "Inspect flow", status: "in_progress" }],
      }),
      event("plan.updated", 2, {
        entries: [
          { id: "inspect", text: "Inspect flow", status: "completed" },
          { id: "verify", text: "Run checks", status: "in_progress" },
        ],
      }),
    ]);

    expect(parseTodos(projected)).toEqual([
      { content: "Inspect flow", status: "completed" },
      { content: "Run checks", status: "in_progress" },
    ]);
  });

  test("projects a file receipt with its durable diff reference and no invented patch", () => {
    const nodes = buildTimelineFromCanonical(
      [
        event("file.changed", 1, {
          path: "/root/work/checkout/order.ts",
          changeType: "edit",
          diff: {
            artifactId: "diff-1",
            bytes: 512,
            sha256: "a".repeat(64),
            contentType: "text/x-diff",
          },
        }),
      ],
      new Map(),
      false,
    );

    expect(nodes).toEqual([
      {
        kind: "file",
        key: "event-1",
        file: {
          path: "/root/work/checkout/order.ts",
          changeType: "edit",
          diff: {
            artifactId: "diff-1",
            bytes: 512,
            sha256: "a".repeat(64),
            contentType: "text/x-diff",
          },
        },
      },
    ]);
  });

  test("keeps generated media in the shared immutable artifact model", () => {
    const nodes = buildTimelineFromCanonical(
      [
        event("artifact.created", 1, {
          name: "checkout-confirmation.png",
          artifact: {
            artifactId: "image-1",
            bytes: 2048,
            sha256: "c".repeat(64),
            contentType: "image/png",
          },
        }),
      ],
      new Map(),
      false,
    );

    expect(nodes).toEqual([
      {
        kind: "artifact",
        key: "event-1",
        artifact: {
          id: "image-1",
          name: "checkout-confirmation.png",
          bytes: 2048,
          sha256: "c".repeat(64),
          contentType: "image/png",
        },
      },
    ]);
  });

  test("keeps terminal output and harness errors visible with real detail", () => {
    const nodes = buildTimelineFromCanonical(
      [
        event("terminal.output", 1, {
          terminalId: "shell-1",
          chunk: "tests passed\n",
        }),
        event("harness.error", 2, {
          message: "provider stream closed",
          fatal: true,
        }),
      ],
      new Map(),
      false,
    );

    expect(nodes.map((node) => node.kind)).toEqual(["tool", "tool"]);
    const traces = nodes.map((node) =>
      deriveTrace((node as Extract<(typeof nodes)[number], { kind: "tool" }>).step),
    );
    expect(traces[0]).toMatchObject({
      verb: "Terminal",
      target: "shell-1",
      detail: "tests passed",
      isError: false,
    });
    expect(traces[1]).toMatchObject({
      verb: "Error",
      target: "provider stream closed",
      isError: true,
    });
  });

  test("does not publish a tool result artifact as a conversation attachment", () => {
    const nodes = buildTimelineFromCanonical(
      [
        event("tool.started", 1, {
          toolCallId: "shot-1",
          name: "computer_screenshot",
          title: "Inspect desktop",
        }),
        event("tool.completed", 2, {
          toolCallId: "shot-1",
          status: "ok",
          artifact: {
            artifactId: "private-shot",
            bytes: 2048,
            sha256: "b".repeat(64),
            contentType: "image/png",
          },
        }),
      ],
      new Map(),
      false,
    );

    expect(nodes.some((node) => node.kind === "artifact")).toBe(false);
    expect(nodes.filter((node) => node.kind === "tool")).toHaveLength(1);
  });
});
