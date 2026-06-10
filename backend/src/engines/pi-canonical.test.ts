import { describe, expect, test } from "bun:test";
import {
  NativeBridgeDeltaAccumulator,
  NativeBridgeSequencer,
  type NativeBridgeFrameBody,
} from "@useagent/agent-harness/bridge";
import { createPiRpcFrameMapper, piRpcFrameBodies } from "./pi-canonical";
import { piBridgeProviderEvent } from "./pi-provider-events";
import { translateOpenCode, type OpenCodeFrame } from "@useagent/agent-harness/opencode";

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

  test("preserves Pi child identity across provider-event revisions", () => {
    const frames = new NativeBridgeSequencer("parent-session", () => 1);
    const started = piBridgeProviderEvent(
      { runId: "run", threadId: "thread" },
      frames.frame({
        kind: "child.started",
        childId: "child-a",
        title: "Inspect module",
        launchToolCallId: "launch-call",
      }),
    );
    const updated = piBridgeProviderEvent(
      { runId: "run", threadId: "thread" },
      frames.frame({ kind: "child.updated", childId: "child-a", status: "running" }),
    );
    const completed = piBridgeProviderEvent(
      { runId: "run", threadId: "thread" },
      frames.frame({ kind: "child.completed", childId: "child-a", status: "ok", result: "done" }),
    );

    for (const event of [started, updated, completed]) {
      expect(event.nativeSessionId).toBe("parent-session");
      expect(event.nativeParentSessionId).toBe("parent-session");
      expect(event.payload).toMatchObject({ childSessionId: "child-a" });
    }
    expect(started.payload).toMatchObject({ childEventKind: "child.started" });
    expect(updated.payload).toMatchObject({ childEventKind: "child.updated" });
    expect(completed.payload).toMatchObject({ childEventKind: "child.completed" });
  });

  test("coalesces token-sized Pi reasoning deltas into one durable Thought row", () => {
    const map = createPiRpcFrameMapper("pi-message-run");
    const first = map({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "Let " },
    });
    const second = map({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "me think" },
    });
    expect(first.filter((body) => body.kind === "message.started")).toHaveLength(1);
    expect(second.filter((body) => body.kind === "message.started")).toHaveLength(0);

    const accumulator = new NativeBridgeDeltaAccumulator();
    const sequencer = new NativeBridgeSequencer("session", () => 1);
    const deltas = [...first, ...second].filter(
      (body) => body.kind === "reasoning.delta",
    );
    const events = deltas.map((body) => piBridgeProviderEvent(
      { runId: "run", threadId: "thread" },
      sequencer.frame(accumulator.durable(body)[0]!),
    ));
    expect(events[0]?.id).toBe(events[1]?.id);
    expect(events[1]?.payload).toMatchObject({ text: "Let me think" });

    const finalEvent = events[1]!;
    const translated = translateOpenCode([{
      eventId: finalEvent.id,
      seq: 1,
      provider: "pi",
      eventType: finalEvent.eventType,
      payload: finalEvent.payload,
      native: {
        sessionId: "session",
        parentSessionId: null,
        messageId: "pi-message-run",
        partId: null,
        callId: null,
      },
    }], { runId: "run", threadId: "thread", engine: "pi" });
    expect(translated.events).toContainEqual(expect.objectContaining({
      kind: "reasoning.delta",
      messageId: "pi-message-run",
      text: "Let me think",
    }));
  });

  test("starts a fresh message after every assistant message_end in tool loops", () => {
    const map = createPiRpcFrameMapper("pi-message-run");
    map({ type: "agent_start" });
    const first = map({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Calling tool" },
    });
    map({
      type: "message_end",
      message: { role: "assistant", stopReason: "toolUse", usage: {} },
    });
    const second = map({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Final answer" },
    });
    expect(first).toContainEqual({ kind: "message.started", messageId: "pi-message-run" });
    expect(second).toContainEqual({ kind: "message.started", messageId: "pi-message-run-1" });
    expect(second).toContainEqual({
      kind: "message.delta",
      messageId: "pi-message-run-1",
      text: "Final answer",
    });
  });

  test("uses message_start identity through authoritative message_end content", () => {
    const map = createPiRpcFrameMapper("fallback");
    expect(map({
      type: "message_start",
      message: { role: "assistant", timestamp: 100, content: [] },
    })).toEqual([{ kind: "message.started", messageId: "pi-message-100" }]);
    const streamed = map({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "draft" },
    });
    const ended = map({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 999,
        stopReason: "stop",
        usage: {},
        content: [
          { type: "thinking", thinking: "final thought" },
          { type: "text", text: "rewritten answer" },
        ],
      },
    });
    expect(streamed).toContainEqual({
      kind: "message.delta",
      messageId: "pi-message-100",
      text: "draft",
    });
    expect(ended).toContainEqual({
      kind: "message.authoritative",
      messageId: "pi-message-100",
      text: "rewritten answer",
    });
    expect(ended).toContainEqual({
      kind: "reasoning.authoritative",
      messageId: "pi-message-100",
      text: "final thought",
    });

    const accumulator = new NativeBridgeDeltaAccumulator();
    for (const body of streamed) accumulator.durable(body);
    const final = ended.flatMap((body) => accumulator.durable(body));
    expect(final).toContainEqual(expect.objectContaining({
      kind: "message.delta",
      messageId: "pi-message-100",
      text: "rewritten answer",
      authoritative: true,
    }));
  });

  test("namespaces every Pi provider-event identity by run", () => {
    const bodies: NativeBridgeFrameBody[] = [
      { kind: "turn.started" },
      { kind: "tool.started", toolCallId: "tool", name: "read" },
      { kind: "plan.updated", entries: [{ id: "todo", text: "Check", status: "pending" }] },
      { kind: "commands.updated", commands: [{ name: "compact" }] },
      { kind: "usage.updated", inputTokens: 1 },
      { kind: "child.started", childId: "child" },
    ];
    const sequencer = new NativeBridgeSequencer("shared-session", () => 1);
    for (const body of bodies) {
      const frame = sequencer.frame(body);
      const first = piBridgeProviderEvent({ runId: "run-a", threadId: "thread" }, frame);
      const second = piBridgeProviderEvent({ runId: "run-b", threadId: "thread" }, frame);
      expect(first.id).not.toBe(second.id);
      expect(first.id.startsWith("run-a:pi:")).toBe(true);
      expect(second.id.startsWith("run-b:pi:")).toBe(true);
    }
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

  test("terminal Pi frames survive canonicalization", () => {
    const sequencer = new NativeBridgeSequencer("session", () => 1);
    const providerEvent = piBridgeProviderEvent(
      { runId: "run", threadId: "thread" },
      sequencer.frame({ kind: "turn.completed", stopReason: "stop" }),
    );
    const frame: OpenCodeFrame = {
      eventId: providerEvent.id,
      seq: 1,
      provider: "pi",
      eventType: providerEvent.eventType,
      payload: providerEvent.payload,
      native: {
        sessionId: "session",
        parentSessionId: null,
        messageId: null,
        partId: null,
        callId: null,
      },
    };
    const translated = translateOpenCode([frame], {
      runId: "run",
      threadId: "thread",
      engine: "pi",
    });
    expect(translated.events).toContainEqual(expect.objectContaining({
      kind: "turn.completed",
      stopReason: "stop",
    }));
    expect(translated.accounting[0]?.suppressed).toBeUndefined();
  });
});
