import { describe, expect, test } from "bun:test";
import type { NativeBridgeFrameBody } from "@useagent/agent-harness/bridge";
import { createSecretRedactor } from "../secrets/redact";
import { createNativeBridgeStepProjector } from "./native-bridge-steps";
import { runNativeBridgeTurn } from "./native-bridge-runtime";
import { createPiRpcFrameMapper } from "./pi-canonical";
import type { EmitStep } from "./types";

/** The Pi RPC frames of the audit's hello.txt run (`dc823765`, deepseek-v4-flash),
 * replayed with the recorded tool names, arguments and result bodies. */
const RECORDED_PI_FRAMES: readonly Record<string, unknown>[] = [
  { type: "agent_start" },
  { type: "message_start", message: { role: "assistant", timestamp: 1 } },
  {
    type: "message_update",
    message: { role: "assistant", timestamp: 1 },
    assistantMessageEvent: { type: "thinking_delta", delta: "The user wants me to create a file named hello.txt." },
  },
  {
    type: "message_end",
    message: {
      role: "assistant",
      timestamp: 1,
      content: [{
        type: "toolCall",
        id: "chatcmpl-tool-b4bc5882b1f615a3",
        name: "write",
        arguments: { path: "/root/work/hello.txt", content: "ready" },
      }],
    },
  },
  {
    type: "tool_execution_start",
    toolCallId: "chatcmpl-tool-b4bc5882b1f615a3",
    toolName: "write",
    args: { i: "Create hello.txt with content ready", path: "/root/work/hello.txt", content: "ready" },
  },
  {
    type: "tool_execution_end",
    toolCallId: "chatcmpl-tool-b4bc5882b1f615a3",
    toolName: "write",
    isError: false,
    result: { content: [{ type: "text", text: "Successfully wrote 5 bytes to hello.txt" }] },
  },
  {
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "chatcmpl-tool-b4bc5882b1f615a3",
      toolName: "write",
      isError: false,
      content: [{ type: "text", text: "Successfully wrote 5 bytes to hello.txt" }],
    },
  },
  {
    type: "tool_execution_start",
    toolCallId: "call_00207c0322f74f74aee87879",
    toolName: "bash",
    args: { command: "cat /root/work/hello.txt" },
  },
  {
    type: "tool_execution_end",
    toolCallId: "call_00207c0322f74f74aee87879",
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: "ready\n\nWall time: 0.02 seconds" }] },
  },
  {
    type: "message_end",
    message: {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "text", text: "Done. `/root/work/hello.txt` created with content `ready`." }],
    },
  },
  { type: "agent_end", isTerminal: true, messages: [] },
];

interface CapturedStep {
  readonly id: string;
  step: EmitStep;
  code?: unknown;
}

function fakeCtx() {
  const steps: CapturedStep[] = [];
  return {
    steps,
    ctx: {
      emit: async (step: EmitStep) => {
        const id = `step-${steps.length + 1}`;
        steps.push({ id, step });
        return id;
      },
      updateStep: async (stepId: string, code: unknown) => {
        const found = steps.find((s) => s.id === stepId);
        if (found) found.code = code;
      },
    },
  };
}

const redact = createSecretRedactor([]);

describe("native bridge step projection", () => {
  test("a recorded Pi run projects file and command rows with their output", async () => {
    const { ctx, steps } = fakeCtx();
    const projector = createNativeBridgeStepProjector(ctx, redact);
    const map = createPiRpcFrameMapper("pi-message-test");
    for (const frame of RECORDED_PI_FRAMES) for (const body of map(frame)) projector.observe(body);
    await projector.drain();

    expect(steps.map((s) => [s.step.kind, s.step.label, s.step.chip])).toEqual([
      ["file", "hello.txt", "file"],
      ["command", "cat /root/work/hello.txt", "bash"],
    ]);
    expect(steps[0]!.code).toEqual({
      tool: "write",
      input: { path: "/root/work/hello.txt", content: "ready" },
      output: "Successfully wrote 5 bytes to hello.txt",
      error: false,
    });
    expect(steps[1]!.code).toEqual({
      tool: "bash",
      input: { command: "cat /root/work/hello.txt" },
      output: "ready\n\nWall time: 0.02 seconds",
      error: false,
    });
  });

  test("the running row exists before the tool completes, so Stop sees a turn mid-flight", async () => {
    const { ctx, steps } = fakeCtx();
    const projector = createNativeBridgeStepProjector(ctx, redact);
    projector.observe({
      kind: "tool.started",
      toolCallId: "call-sleep",
      name: "bash",
      input: { command: "sleep 90" },
    });
    await projector.drain();
    expect(steps).toHaveLength(1);
    expect(steps[0]!.step.kind).toBe("command");
    expect(steps[0]!.step.code_json).toEqual({ tool: "bash", input: { command: "sleep 90" } });
    expect(steps[0]!.code).toBeUndefined();
  });

  test("one row per call id: Pi announces a call from the assistant message and again at execution", async () => {
    const { ctx, steps } = fakeCtx();
    const projector = createNativeBridgeStepProjector(ctx, redact);
    projector.observe({ kind: "tool.started", toolCallId: "c", name: "bash", input: { command: "cat hello.txt" } });
    projector.observe({ kind: "tool.started", toolCallId: "c", name: "bash", input: { command: "cat hello.txt", i: "Print it" } });
    projector.observe({ kind: "tool.completed", toolCallId: "c", name: "bash", status: "ok", preview: "ready" });
    projector.observe({ kind: "tool.completed", toolCallId: "c", name: "bash", status: "ok", preview: "ready" });
    await projector.drain();
    expect(steps).toHaveLength(1);
    expect(steps[0]!.code).toMatchObject({ output: "ready", error: false });
  });

  test("a failed tool marks its row and keeps the error text", async () => {
    const { ctx, steps } = fakeCtx();
    const projector = createNativeBridgeStepProjector(ctx, redact);
    projector.observe({ kind: "tool.started", toolCallId: "c", name: "bash", input: { command: "false" } });
    projector.observe({
      kind: "tool.completed",
      toolCallId: "c",
      name: "bash",
      status: "error",
      preview: "ignored",
      error: "exit status 1",
    });
    await projector.drain();
    expect(steps[0]!.code).toMatchObject({ error: true, output: "exit status 1" });
  });

  test("child-owned tool frames and unknown completions never become parent rows", async () => {
    const { ctx, steps } = fakeCtx();
    const projector = createNativeBridgeStepProjector(ctx, redact);
    projector.observe({
      kind: "tool.started",
      toolCallId: "child-call",
      name: "bash",
      input: { command: "ls" },
      ownerChildId: "child-a",
    });
    projector.observe({ kind: "tool.completed", toolCallId: "never-started", status: "ok" });
    await projector.drain();
    expect(steps).toHaveLength(0);
  });

  test("secrets in tool input and output are redacted before persistence", async () => {
    const { ctx, steps } = fakeCtx();
    const secret = "sk-live-secret-value-0123456789";
    const projector = createNativeBridgeStepProjector(ctx, createSecretRedactor([secret]));
    projector.observe({ kind: "tool.started", toolCallId: "c", name: "bash", input: { command: `curl -H ${secret}` } });
    projector.observe({ kind: "tool.completed", toolCallId: "c", status: "ok", preview: `token=${secret}` });
    await projector.drain();
    expect(JSON.stringify(steps[0]!.step.code_json)).not.toContain(secret);
    expect(JSON.stringify(steps[0]!.code)).not.toContain(secret);
  });

  test("the bridge turn runner drives the projector from raw provider frames", async () => {
    const { ctx, steps } = fakeCtx();
    let listener: ((frame: unknown) => void) | undefined;
    const mappedBodies = (frame: unknown): readonly NativeBridgeFrameBody[] =>
      (frame as { bodies?: readonly NativeBridgeFrameBody[] }).bodies ?? [];
    const summary = await runNativeBridgeTurn({
      ctx: {
        ...ctx,
        runId: "run",
        threadId: "thread",
        signal: new AbortController().signal,
        reportActivity: () => {},
      } as never,
      driver: {
        steer: async () => {
          listener?.({
            bodies: [
              { kind: "tool.started", toolCallId: "c1", name: "bash", input: { command: "echo hi" } },
              { kind: "tool.completed", toolCallId: "c1", name: "bash", status: "ok", preview: "hi" },
              { kind: "message.delta", messageId: "m", text: "done" },
              { kind: "turn.completed" },
            ],
          });
          return { status: "ok" };
        },
        cancel: async () => ({ status: "ok" }),
      } as never,
      session: { nativeSessionId: "parent" } as never,
      bridge: {
        sessionFile: "/sessions/pi.jsonl",
        subscribe: (next) => {
          listener = next;
          return () => {};
        },
      },
      prompt: "say hi",
      mapFrame: mappedBodies,
      redact,
    }, async () => {});
    expect(summary).toBe("done");
    expect(steps.map((s) => s.step.label)).toEqual(["echo hi"]);
    expect(steps[0]!.code).toMatchObject({ output: "hi", error: false });
  });
});
