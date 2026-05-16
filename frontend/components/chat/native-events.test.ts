import { describe, expect, test } from "bun:test";
import {
  deriveChildFidelity,
  NATIVE_SCHEMA_VERSION,
  type NativeFrame,
  parseNativeFrame,
} from "./native-events";

// A raw wire frame as it arrives in an SSE `native` event's JSON `data`.
function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: "pe_1",
    seq: 0,
    provider: "opencode",
    eventType: "part.text",
    native: {
      sessionId: "ses_c",
      parentSessionId: "ses_root",
      messageId: null,
      partId: "prt_1",
      callId: null,
    },
    payload: {},
    ...over,
  };
}

function parsed(over: Record<string, unknown> = {}): NativeFrame {
  const frame = parseNativeFrame(raw(over));
  if (!frame) throw new Error("expected a valid native frame fixture");
  return frame;
}

describe("parseNativeFrame", () => {
  test("parses a well-formed frame", () => {
    const f = parsed();
    expect(f.eventId).toBe("pe_1");
    expect(f.native.sessionId).toBe("ses_c");
    expect(f.native.parentSessionId).toBe("ses_root");
  });

  test("rejects malformed frames (missing required fields)", () => {
    expect(parseNativeFrame(null)).toBeNull();
    expect(parseNativeFrame(raw({ eventId: undefined }))).toBeNull();
    expect(parseNativeFrame(raw({ seq: "nope" }))).toBeNull();
    expect(parseNativeFrame(raw({ eventType: undefined }))).toBeNull();
  });

  test("treats a missing schemaVersion as the current version", () => {
    expect(parsed({ schemaVersion: undefined }).schemaVersion).toBe(NATIVE_SCHEMA_VERSION);
  });

  test("accepts a newer schemaVersion best-effort (forward-compatible)", () => {
    const f = parsed({ schemaVersion: 99 });
    expect(f.schemaVersion).toBe(99);
    expect(f.eventId).toBe("pe_1"); // known fields still read
  });

  test("tolerates a missing native object", () => {
    const f = parsed({ native: undefined });
    expect(f.native.sessionId).toBeNull();
  });
});

// Real captured shapes (run fdc7c3f3 / confirmed part.tool.error shape): the
// parent's task tool part carries state.output with <task id> + <task_result>,
// keyed by the parent's call id.
const ROOT = "ses_root";
const CHILD_A = "ses_childA";
const CHILD_B = "ses_childB";
let seq = 0;
function taskFrame(
  callId: string,
  childSid: string,
  status: "completed" | "error" | "running",
  result?: string,
): NativeFrame {
  const output =
    status === "running"
      ? ""
      : `<task id="${childSid}" state="${status}">\n<task_result>\n${result ?? "ok"}\n</task_result>\n</task>`;
  return {
    schemaVersion: 1,
    eventId: `pe_task_${callId}`,
    seq: seq++,
    provider: "opencode",
    eventType: `part.tool.${status}`,
    native: {
      sessionId: ROOT,
      parentSessionId: null,
      messageId: "m",
      partId: `prt_${callId}`,
      callId,
    },
    payload: { type: "tool", tool: "task", callID: callId, state: { status, output } },
  };
}
function textFrame(sid: string, text: string): NativeFrame {
  return {
    schemaVersion: 1,
    eventId: `pe_text_${sid}_${seq}`,
    seq: seq++,
    provider: "opencode",
    eventType: "part.text",
    native: {
      sessionId: sid,
      parentSessionId: ROOT,
      messageId: "m",
      partId: `prt_${seq}`,
      callId: null,
    },
    payload: { type: "text", text },
  };
}

describe("deriveChildFidelity", () => {
  test("a failed child reads failed while its sibling reads completed", () => {
    seq = 0;
    const fidelity = deriveChildFidelity([
      taskFrame("call_a", CHILD_A, "completed", "wrote p1"),
      taskFrame("call_b", CHILD_B, "error", "boom"),
    ]);
    expect(fidelity.get("call_a")?.status).toBe("completed");
    expect(fidelity.get("call_b")?.status).toBe("failed");
    // Each links to its own child session — independent, not run-level.
    expect(fidelity.get("call_a")?.childSessionId).toBe(CHILD_A);
    expect(fidelity.get("call_b")?.childSessionId).toBe(CHILD_B);
  });

  test("preserves the child's returned answer (task_result)", () => {
    seq = 0;
    const fidelity = deriveChildFidelity([
      taskFrame("call_a", CHILD_A, "completed", "Confirmed! DELTA written."),
    ]);
    expect(fidelity.get("call_a")?.resultText).toBe("Confirmed! DELTA written.");
  });

  test("parses non-session T3 child ids from task output", () => {
    seq = 0;
    const fidelity = deriveChildFidelity([
      taskFrame("tool-call-nvidia", "nvidia_price_1", "completed", "NVDA 181.77"),
    ]);
    expect(fidelity.get("tool-call-nvidia")?.childSessionId).toBe("nvidia_price_1");
  });

  test("running task (no output yet) → running, and falls back to child assistant text", () => {
    seq = 0;
    const fidelity = deriveChildFidelity([
      taskFrame("call_a", CHILD_A, "running"),
      // once the child id is known, a later completed frame links it
      taskFrame("call_a", CHILD_A, "completed"),
      textFrame(CHILD_A, "streaming answer…"),
    ]);
    // The completed frame set status; resultText falls back to the child's text
    // when the tool output carried no <task_result>.
    expect(fidelity.get("call_a")?.status).toBe("completed");
  });

  test("ignores unknown frame types safely", () => {
    seq = 0;
    const fidelity = deriveChildFidelity([
      {
        schemaVersion: 1,
        eventId: "pe_s",
        seq: 0,
        provider: "opencode",
        eventType: "session.updated",
        native: {
          sessionId: CHILD_A,
          parentSessionId: ROOT,
          messageId: null,
          partId: null,
          callId: null,
        },
        payload: { id: CHILD_A },
      },
      taskFrame("call_a", CHILD_A, "completed", "done"),
    ]);
    expect(fidelity.size).toBe(1);
    expect(fidelity.get("call_a")?.status).toBe("completed");
  });

  test("derives independent T3 subagent state from task lifecycle frames", () => {
    const frame = (
      eventId: string,
      frameSeq: number,
      kind: "task.started" | "task.progress" | "task.completed",
      taskId: string,
      payload: Record<string, unknown> = {},
    ): NativeFrame => ({
      schemaVersion: 1,
      eventId,
      seq: frameSeq,
      provider: "t3",
      eventType: `t3.activity.${kind}`,
      native: {
        sessionId: "skynet-thread-1",
        parentSessionId: null,
        messageId: null,
        partId: eventId,
        callId: taskId,
      },
      payload: {
        id: eventId,
        kind,
        payload: { taskId, agentKind: "agent", ...payload },
      },
    });

    const fidelity = deriveChildFidelity([
      frame("a-start", 1, "task.started", "agent-a"),
      frame("b-start", 2, "task.started", "agent-b"),
      frame("a-progress", 3, "task.progress", "agent-a", { summary: "Checking auth" }),
      frame("b-done", 4, "task.completed", "agent-b", {
        status: "failed",
        error: "Tests failed",
      }),
      frame("a-done", 5, "task.completed", "agent-a", {
        status: "completed",
        summary: "Auth is sound",
      }),
    ]);

    expect(fidelity.get("agent-a")).toMatchObject({
      status: "completed",
      childSessionId: "agent-a",
      resultText: "Auth is sound",
    });
    expect(fidelity.get("agent-b")).toMatchObject({
      status: "failed",
      childSessionId: "agent-b",
      resultText: "Tests failed",
    });
  });

  test("folds T3 idle resume state, progress, and cumulative usage", () => {
    const frame = (
      eventId: string,
      frameSeq: number,
      kind: "task.started" | "task.progress" | "task.updated",
      payload: Record<string, unknown>,
    ): NativeFrame => ({
      schemaVersion: 1,
      eventId,
      seq: frameSeq,
      provider: "t3",
      eventType: `t3.activity.${kind}`,
      native: {
        sessionId: "skynet-thread-1",
        parentSessionId: null,
        messageId: null,
        partId: eventId,
        callId: "agent-a",
      },
      payload: { id: eventId, kind, payload: { taskId: "agent-a", agentKind: "agent", ...payload } },
    });

    const fidelity = deriveChildFidelity([
      frame("start", 1, "task.started", { title: "Price researcher" }),
      frame("progress", 2, "task.progress", {
        summary: "Reading the latest quote",
        typedUsage: { totalTokens: 120, inputTokens: 100, outputTokens: 20 },
      }),
      frame("late-smaller-usage", 3, "task.progress", {
        typedUsage: { totalTokens: 90, outputTokens: 10 },
        usageSnapshot: true,
      }),
      frame("idle", 4, "task.updated", { status: "idle" }),
    ]);

    expect(fidelity.get("agent-a")).toMatchObject({
      status: "idle",
      progress: "Reading the latest quote",
      usage: { totalTokens: 120, inputTokens: 100, outputTokens: 20 },
      recentActivity: [{ summary: "Reading the latest quote" }],
    });
  });

  test("keeps T3 background tasks out of the subagent roster", () => {
    const fidelity = deriveChildFidelity([
      {
        schemaVersion: 1,
        eventId: "shell-start",
        seq: 1,
        provider: "t3",
        eventType: "t3.activity.task.started",
        native: {
          sessionId: "skynet-thread-1",
          parentSessionId: null,
          messageId: null,
          partId: "shell-start",
          callId: "shell-1",
        },
        payload: {
          id: "shell-start",
          kind: "task.started",
          payload: { taskId: "shell-1", agentKind: "background", taskType: "shell" },
        },
      },
    ]);
    expect(fidelity.size).toBe(0);
  });
});
