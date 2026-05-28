import { describe, expect, test } from "bun:test";
import {
  acpToolResultFailed,
  buildAcpToolCompletion,
  buildAcpToolStep,
} from "./acp-tool-step";

const native = {
  sessionID: "ses_1",
  messageID: "msg_tool_1",
  partID: "part_tool_1",
  callID: "call_1",
} as const;

describe("acpToolResultFailed", () => {
  test("detects gateway application errors inside completed ACP results", () => {
    expect(acpToolResultFailed({
      result: {
        content: [{ type: "text", text: "Approval required" }],
        structuredContent: { error: "approval_required" },
        isError: true,
      },
    })).toBe(true);
    expect(acpToolResultFailed({
      result: { content: [{ type: "text", text: "ok" }], isError: false },
    })).toBe(false);
  });
});

describe("buildAcpToolStep", () => {
  test("stamps stable native ids so the canonical timeline can order the tool", () => {
    const step = buildAcpToolStep(
      { kind: "execute", title: "Run", rawInput: { command: "pwd" } },
      undefined,
      native,
    );

    expect(step.code_json).toEqual({
      tool: "execute",
      title: "Run",
      input: { command: "pwd" },
      native,
    });
  });

  test("preserves native ids and marks a failed completion", () => {
    const step = buildAcpToolStep(
      { kind: "execute", title: "Run", rawInput: { command: "false" } },
      "exit 1",
      native,
      true,
    );

    expect(step.code_json).toMatchObject({ native, error: true, output: "exit 1" });
  });

  test("preserves an MCP method name when ACP classifies it as other", () => {
    const step = buildAcpToolStep(
      {
        kind: "other",
        title: "mcp__skynet-browser__browser_navigate",
        rawInput: { url: "https://example.com" },
      },
      "navigated",
      native,
    );

    expect(step.code_json).toMatchObject({
      tool: "mcp__skynet-browser__browser_navigate",
      title: "mcp__skynet-browser__browser_navigate",
    });
    expect(step.chip).toBe("mcp");
  });

  test("does not overwrite an MCP method with other when its result arrives", () => {
    const update = {
      kind: "other",
      title: "mcp__skynet-browser__browser_click",
      rawInput: { element: "Close button", ref: "e152" },
    };

    expect(buildAcpToolCompletion(update, "clicked", native, false)).toEqual({
      tool: "mcp__skynet-browser__browser_click",
      title: "mcp__skynet-browser__browser_click",
      input: { element: "Close button", ref: "e152" },
      output: "clicked",
      native,
      status: "completed",
    });
  });

  test("recognizes upstream codex-acp subagent start metadata as a subagent card", () => {
    const step = buildAcpToolStep(
      {
        kind: "other",
        title: "Start subagent weather_research",
        toolCallId: "call-spawn-weather",
        status: "completed",
        rawInput: {
          agentThreadId: "thread-paris",
          agentPath: "/root/weather_research",
          activityKind: "started",
        },
        _meta: {
          codex: {
            subagent: {
              threadId: "thread-paris",
              path: "/root/weather_research",
              activity: "started",
            },
          },
        },
      },
      undefined,
      native,
    );

    expect(step).toMatchObject({
      kind: "task",
      label: "Subagent — weather_research",
      chip: "subagent",
      code_json: {
        tool: "subagent",
        subagent: {
          activity: "spawn",
          threadId: "thread-paris",
          path: "/root/weather_research",
          name: "weather_research",
        },
        native: {
          ...native,
          childSessionID: "thread-paris",
        },
      },
    });
  });

  test("groups codex-acp subagent follow-up activity by the child thread id", () => {
    const step = buildAcpToolStep(
      {
        kind: "other",
        title: "Interact with subagent weather_research",
        toolCallId: "call-interact-weather",
        rawInput: {
          agentThreadId: "thread-paris",
          agentPath: "/root/weather_research",
          activityKind: "interacted",
        },
        _meta: {
          codex: {
            subagent: {
              threadId: "thread-paris",
              path: "/root/weather_research",
              activity: "interacted",
            },
          },
        },
      },
      "queued",
      native,
    );

    expect(step).toMatchObject({
      kind: "task",
      label: "↳ Interact — weather_research",
      chip: "task",
      code_json: {
        tool: "subagent",
        output: "queued",
        subagent: {
          activity: "interact",
          threadId: "thread-paris",
          path: "/root/weather_research",
          name: "weather_research",
        },
        native: {
          ...native,
          parentSessionID: "ses_1",
          sessionID: "thread-paris",
          childSessionID: "thread-paris",
        },
      },
    });
  });

  test("recognizes Codex subagent tool names without inventing missing child ids", () => {
    const spawn = buildAcpToolStep(
      {
        kind: "execute",
        title: "spawn_agent",
        rawInput: { prompt: "review the tests" },
      },
      undefined,
      native,
    );
    expect(spawn).toMatchObject({
      kind: "task",
      label: "Subagent — review the tests",
      chip: "subagent",
      code_json: {
        tool: "subagent",
        native,
        subagent: { activity: "spawn" },
      },
    });
    expect((spawn.code_json as { native: { childSessionID?: string } }).native.childSessionID).toBeUndefined();

    for (const [title, activity, label] of [
      ["wait_agent", "wait", "↳ Wait — agent-1"],
      ["close_agent", "close", "↳ Close — agent-1"],
    ] as const) {
      const step = buildAcpToolStep(
        { kind: "execute", title, rawInput: { agentId: "agent-1" } },
        undefined,
        native,
      );

      expect(step).toMatchObject({
        kind: "task",
        label,
        chip: "task",
        code_json: {
          tool: "subagent",
          native: {
            ...native,
            parentSessionID: "ses_1",
            sessionID: "agent-1",
            childSessionID: "agent-1",
          },
          subagent: { activity, threadId: "agent-1" },
        },
      });
    }
  });
});
