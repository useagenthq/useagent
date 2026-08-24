import { describe, expect, test } from "bun:test";
import { NativeBridgeSequencer } from "@useagent/agent-harness/bridge";
import { piRpcFrameBodies } from "./pi-canonical";
import { piBridgeProviderEvent } from "./pi-provider-events";

describe("Pi RPC canonical bridge mapping", () => {
  test("maps a bounded MCP tool lifecycle without losing call identity", () => {
    expect(piRpcFrameBodies({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "mcp__skynet-knowledge__skills_list",
      args: { query: "release" },
    })).toEqual([{
      kind: "tool.started",
      toolCallId: "call-1",
      name: "mcp__skynet-knowledge__skills_list",
      input: { query: "release" },
    }]);
    expect(piRpcFrameBodies({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "mcp__skynet-knowledge__skills_list",
      result: { content: [{ type: "text", text: "ok" }] },
    })[0]).toMatchObject({ kind: "tool.completed", toolCallId: "call-1", status: "ok" });
  });

  test("maps native Pi child lifecycle and progress", () => {
    expect(piRpcFrameBodies({
      type: "subagent_lifecycle",
      payload: {
        id: "child-1",
        agent: "task",
        agentSource: "bundled",
        description: "Inspect module",
        status: "started",
        index: 0,
        sessionFile: "/sessions/child.jsonl",
        parentToolCallId: "call-task",
      },
    })).toEqual([{
      kind: "child.started",
      childId: "child-1",
      title: "Inspect module",
      launchToolCallId: "call-task",
      state: {
        status: "started",
        prompt: "Inspect module",
        role: "task",
        resumable: true,
      },
    }]);
    expect(piRpcFrameBodies({
      type: "subagent_progress",
      payload: {
        id: "child-1",
        task: "Inspect module",
        progress: {
          id: "child-1",
          status: "running",
          currentTool: "read",
          tokens: 42,
          cost: 0.01,
          durationMs: 250,
          recentOutput: ["opened file"],
          resolvedModel: "openai/gpt-5.6-luna",
        },
      },
    })[0]).toMatchObject({
      kind: "child.updated",
      childId: "child-1",
      state: { lastToolName: "read", usage: { tokens: 42, costUsd: 0.01, durationMs: 250 } },
    });
  });

  test("uses one stable provider-event id for tool revisions", () => {
    const frames = new NativeBridgeSequencer("session", () => 1);
    const started = piBridgeProviderEvent(
      { runId: "run", threadId: "thread" },
      frames.frame({ kind: "tool.started", toolCallId: "call", name: "read" }),
    );
    const completed = piBridgeProviderEvent(
      { runId: "run", threadId: "thread" },
      frames.frame({ kind: "tool.completed", toolCallId: "call", status: "ok" }),
    );
    expect(started.id).toBe(completed.id);
    expect(started.eventType).toBe("part.tool");
    expect(completed.eventType).toBe("part.tool.completed");
  });

  test("classifies a terminal provider error as a failed turn", () => {
    expect(piRpcFrameBodies({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider rejected request",
        usage: { input: 1, output: 0 },
      },
    })).toContainEqual({
      kind: "turn.failed",
      error: "provider rejected request",
      stopReason: "error",
    });
  });
});
