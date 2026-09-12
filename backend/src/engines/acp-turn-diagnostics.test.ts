import { describe, expect, test } from "bun:test";
import {
  acpFrameTraceEnabled,
  createAcpFrameTrace,
  describeAcpTurnStall,
  summarizeAcpFrame,
} from "./acp-turn-diagnostics";

describe("summarizeAcpFrame", () => {
  test("tool_call updates keep ids, status, kind and a short title but never content", () => {
    const line = summarizeAcpFrame({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_1",
          kind: "execute",
          status: "in_progress",
          title: "cat hello.txt",
          content: [{ type: "content", content: { type: "text", text: "SECRET OUTPUT" } }],
        },
      },
    });
    expect(line).toBe('session/update tool_call call=call_1 status=in_progress kind=execute title="cat hello.txt"');
    expect(line).not.toContain("SECRET OUTPUT");
  });

  test("permission requests list the tool call kind and every option", () => {
    expect(
      summarizeAcpFrame({
        jsonrpc: "2.0",
        id: 3,
        method: "session/request_permission",
        params: {
          toolCall: { toolCallId: "call_1", kind: "execute", status: "pending" },
          options: [
            { optionId: "allow_once", kind: "allow_once" },
            { optionId: "reject_once", kind: "reject_once" },
          ],
        },
      }),
    ).toBe("session/request_permission #3 call=call_1 kind=execute options=[allow_once:allow_once,reject_once:reject_once]");
  });

  test("responses show the permission outcome, the stop reason, or an error", () => {
    expect(summarizeAcpFrame({ jsonrpc: "2.0", id: 3, result: { outcome: { outcome: "selected", optionId: "allow_once" } } }))
      .toBe("response #3 outcome=selected:allow_once");
    expect(summarizeAcpFrame({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } }))
      .toBe("response #2 stopReason=end_turn");
    expect(summarizeAcpFrame({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } }))
      .toBe('response #1 error={"code":-32603,"message":"boom"}');
    expect(summarizeAcpFrame({ jsonrpc: "2.0", id: 4, result: { sessionId: "s1" } }))
      .toBe("response #4 result{sessionId}");
  });
});

describe("createAcpFrameTrace", () => {
  test("keeps only the last frames, redacts summaries and echoes when asked", () => {
    const echoed: string[] = [];
    let now = 1000;
    const trace = createAcpFrameTrace({
      limit: 2,
      redact: (text) => text.replace("hunter2", "[redacted]"),
      echo: (line) => echoed.push(line),
      now: () => now,
    });
    trace.record("out", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    now = 2000;
    trace.record("in", { jsonrpc: "2.0", id: 1, result: {} });
    now = 3000;
    trace.record("in", {
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", toolCallId: "c", title: "echo hunter2" } },
    });
    expect(trace.frames().map((f) => f.summary)).toEqual([
      "response #1 result{}",
      'session/update tool_call call=c title="echo [redacted]"',
    ]);
    expect(trace.frames().map((f) => f.at)).toEqual([2000, 3000]);
    expect(echoed).toEqual([
      "-> initialize #1",
      "<- response #1 result{}",
      '<- session/update tool_call call=c title="echo [redacted]"',
    ]);
  });

  test("tracing is opt-in through ACP_FRAME_TRACE", () => {
    expect(acpFrameTraceEnabled({})).toBe(false);
    expect(acpFrameTraceEnabled({ ACP_FRAME_TRACE: "0" })).toBe(false);
    expect(acpFrameTraceEnabled({ ACP_FRAME_TRACE: "1" })).toBe(true);
    expect(acpFrameTraceEnabled({ ACP_FRAME_TRACE: "true" })).toBe(true);
  });
});

describe("describeAcpTurnStall", () => {
  test("names the open tool call and the last frame instead of a bare stream error", () => {
    const stall = describeAcpTurnStall({
      engine: "codex",
      reason: "exceeded its 360s budget",
      nowMs: 400_000,
      openToolCalls: [
        { id: "call_1", kind: "execute", title: "printf ready > hello.txt", startedAt: 50_000 },
        { id: "call_2", kind: "execute", title: "cat hello.txt", startedAt: 60_000 },
      ],
      frames: [
        { at: 49_000, direction: "in", summary: "session/update tool_call call=call_1 kind=execute" },
        { at: 55_000, direction: "in", summary: "session/request_permission #1 call=call_1 kind=execute options=[allow_once:allow_once]" },
        { at: 55_100, direction: "out", summary: "response #1 outcome=selected:allow_once" },
      ],
      relayLog: "  codex-acp: something\n  went wrong  ",
      agentLog: "",
    });
    expect(stall.summary).toBe(
      'codex turn exceeded its 360s budget with 2 tool calls still open: [execute] "printf ready > hello.txt" (started 350s ago) and 1 more; ' +
        "last ACP frame 345s ago (out): response #1 outcome=selected:allow_once",
    );
    expect(stall.detail.split("\n")).toEqual([
      stall.summary,
      '  also open: [execute] "cat hello.txt" (started 340s ago)',
      "   351s ago <- session/update tool_call call=call_1 kind=execute",
      "   345s ago <- session/request_permission #1 call=call_1 kind=execute options=[allow_once:allow_once]",
      "   345s ago -> response #1 outcome=selected:allow_once",
      "  relay log tail: codex-acp: something went wrong",
    ]);
  });

  test("says so when nothing was open and nothing arrived", () => {
    const stall = describeAcpTurnStall({
      engine: "claude",
      reason: "lost its relay stream (ACP child process exited)",
      nowMs: 10_000,
      openToolCalls: [],
      frames: [],
    });
    expect(stall.summary).toBe(
      "claude turn lost its relay stream (ACP child process exited) with no tool call open; no ACP frame was received",
    );
    expect(stall.detail).toBe(stall.summary);
  });
});
