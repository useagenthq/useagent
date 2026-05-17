// Phase 1 gate: the OpenCode->canonical translator is LOSSLESS at the transport
// boundary and FULLY ACCOUNTED against the protected golden fixture
// (test/fixtures/opencode-heavy.json). Every source frame yields a
// recorded disposition (canonical kinds produced, or a NAMED suppression) - no
// silent drops. Child-session text/reasoning is preserved (with identity); the
// translator hides nothing. Runs alongside the existing lane; no runtime change.

import { describe, expect, test } from "bun:test";
import heavy from "./fixtures/opencode-heavy.json";
import { translateOpenCode, type OpenCodeFrame, type OpenCodeStep } from "../src/opencode-canonical";
import { assertNeverEvent, type CanonicalAgentEvent } from "../src/canonical";

const frames = heavy as unknown as OpenCodeFrame[];
const CTX = { runId: "run_test", threadId: "thread_test" };
const { events, accounting } = translateOpenCode(frames, CTX);

function countBy<T>(xs: T[], k: (x: T) => string): Record<string, number> {
  const by: Record<string, number> = {};
  for (const x of xs) by[k(x)] = (by[k(x)] ?? 0) + 1;
  return by;
}
const outKinds = countBy(events, (e) => e.kind);
const srcTypes = countBy(frames, (f) => f.eventType);

function assertKnownKind(e: CanonicalAgentEvent): void {
  switch (e.kind) {
    case "session.started": case "session.metadata": case "turn.started":
    case "turn.completed": case "message.started": case "message.delta": case "message.completed":
    case "reasoning.delta": case "reasoning.completed": case "plan.updated":
    case "tool.started": case "tool.progress": case "tool.completed":
    case "file.changed": case "artifact.created": case "artifact.delivered":
    case "terminal.output": case "child.started":
    case "child.updated": case "child.completed": case "approval.requested":
    case "approval.resolved": case "question.requested": case "question.resolved":
    case "commands.updated": case "mode.updated": case "usage.updated":
    case "context.marker": case "harness.warning": case "harness.error":
      return;
    default: assertNeverEvent(e);
  }
}

describe("engine provenance on step-derived events (P1-final #2)", () => {
  const oneStep: OpenCodeStep[] = [
    { id: "s0", idx: 0, kind: "command", label: "ls", code_json: JSON.stringify({ tool: "execute", native: { callID: "c1" } }) },
  ];
  for (const engine of ["opencode", "claude", "codex"] as const) {
    test(`engine "${engine}" stamps its step tool row + accounting with provider "${engine}"`, () => {
      const r = translateOpenCode([], { runId: "r", threadId: "r", engine }, oneStep);
      const tool = r.events.find((e) => e.kind === "tool.completed");
      expect(tool).toBeDefined();
      expect((tool!.identity as { provider?: string }).provider).toBe(engine);
      expect(r.accounting.every((d) => d.provider === engine)).toBe(true);
    });
  }
  test("no engine defaults to opencode (backward compatible)", () => {
    const r = translateOpenCode([], { runId: "r", threadId: "r" }, oneStep);
    expect((r.events.find((e) => e.kind === "tool.completed")!.identity as { provider?: string }).provider).toBe("opencode");
  });
});

describe("OpenCode -> canonical: accounting + losslessness (golden fixture)", () => {
  test("FULL accounting: one disposition per source frame, none silent", () => {
    expect(accounting.length).toBe(frames.length);
    for (const d of accounting) {
      const ok = d.produced.length > 0 || (typeof d.suppressed === "string" && d.suppressed.length > 0);
      if (!ok) console.log("[canonical] unaccounted:", d);
      expect(ok).toBe(true);
    }
  });

  test("accounting sums exactly to the emitted event stream", () => {
    const summed = accounting.reduce((n, d) => n + d.produced.length, 0);
    expect(summed).toBe(events.length);
  });

  test("no source event maps to an 'unmapped' warning (full coverage)", () => {
    const unmapped = events.filter((e) => e.kind === "harness.warning" && /^unmapped/.test((e as { message: string }).message));
    if (unmapped.length) console.log("[canonical] unmapped:", [...new Set(unmapped.map((e) => (e as { rawEventType?: string }).rawEventType))]);
    expect(unmapped.length).toBe(0);
  });

  test("LOSSLESS: every part.text with a messageId is preserved (incl. child sessions)", () => {
    // Slice-1 dropped child text; now it is preserved with identity. message.delta ==
    // all part.text frames carrying a messageId (137 child + 6 root in this fixture).
    const textWithMid = frames.filter((f) => f.eventType.startsWith("part.text") && f.native.messageId).length;
    expect(outKinds["message.delta"] ?? 0).toBe(textWithMid);
    // child sessions are announced (child.started) so reducers can route their parts.
    const childSess = new Set(frames.filter((f) => f.native.parentSessionId && f.native.sessionId).map((f) => f.native.sessionId));
    expect(outKinds["child.started"] ?? 0).toBeGreaterThanOrEqual(childSess.size);
    // and child text carries its session identity (not stripped).
    const childText = events.filter((e) => e.kind === "message.delta" && e.identity.nativeSessionId && childSess.has(e.identity.nativeSessionId));
    expect(childText.length).toBeGreaterThan(0);
    console.log("[canonical] frames:", frames.length, "-> events:", events.length, outKinds);
  });

  test("every emitted event is a KNOWN canonical kind (exhaustive)", () => {
    for (const e of events) assertKnownKind(e);
  });

  test("well-formed envelope + dense monotonic seq + unique ids", () => {
    for (const e of events) {
      expect(e.schemaVersion).toBe(1);
      expect(e.runId).toBe("run_test");
      expect(e.identity.provider.length).toBeGreaterThan(0);
    }
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
  });

  test("tool + reasoning frames map to their canonical kinds", () => {
    expect(outKinds["tool.completed"] ?? 0).toBe((srcTypes["part.tool.completed"] ?? 0) + (srcTypes["part.tool.error"] ?? 0));
    expect(outKinds["reasoning.delta"] ?? 0).toBe(srcTypes["part.reasoning"] ?? 0);
  });
});

// Real fixture has no task-tool fan-out, so prove child.* equivalence on the SAME
// synthetic task frames the legacy deriveChildFidelity golden uses.
describe("child derivation equivalence (synthetic task frames)", () => {
  const taskFrames: OpenCodeFrame[] = [
    { eventId: "e1", seq: 1, provider: "opencode", eventType: "part.tool.completed",
      native: { sessionId: "ses_p", parentSessionId: null, messageId: "m1", partId: "p1", callId: "call_1" },
      payload: { type: "tool", tool: "task", state: { status: "completed", output: '<task id="ses_child1"><task_result>the answer</task_result></task>' } } },
    { eventId: "e2", seq: 2, provider: "opencode", eventType: "part.tool.error",
      native: { sessionId: "ses_p", parentSessionId: null, messageId: "m1", partId: "p2", callId: "call_2" },
      payload: { type: "tool", tool: "task", state: { status: "error", output: "" } } },
  ];
  test("task tool -> child.started + child.completed with derived id/result/status", () => {
    const { events: ev } = translateOpenCode(taskFrames, CTX);
    const done = ev.filter((e) => e.kind === "child.completed") as { childId: string; status: string; result?: string }[];
    expect(ev.filter((e) => e.kind === "child.started").length).toBe(2);
    const c1 = done.find((e) => e.childId === "ses_child1");
    expect(c1?.status).toBe("ok");
    expect(c1?.result).toBe("the answer");
    expect(done.find((e) => e.status === "error")).toBeTruthy();
  });
});

describe("T3 activity fidelity", () => {
  const t3Frame = (
    eventId: string,
    seq: number,
    eventType: string,
    payload: unknown,
    callId: string | null = null,
  ): OpenCodeFrame => ({
    eventId,
    seq,
    provider: "t3",
    eventType,
    native: { sessionId: "ses_t3", parentSessionId: null, messageId: null, partId: null, callId },
    payload,
  });

  test("maps T3 tool lifecycle to named tool events with bounded detail and no raw argument exposure", () => {
    const result = translateOpenCode([
      t3Frame("tool-start", 1, "t3.activity.tool.started", {
        id: "act_tool_start",
        kind: "tool.started",
        summary: "Fetch quote",
        payload: {
          toolUseId: "tool_1",
          toolName: "webfetch",
          data: { item: { arguments: { url: "https://finance.example/private" } } },
        },
      }),
      t3Frame("tool-progress", 2, "t3.activity.tool.progress", {
        id: "act_tool_progress",
        kind: "tool.progress",
        detail: "Opening finance source",
        payload: { toolUseId: "tool_1", toolName: "webfetch" },
      }),
      t3Frame("tool-done", 3, "t3.activity.tool.completed", {
        id: "act_tool_done",
        kind: "tool.completed",
        summary: "Fetched current quote",
        payload: { toolUseId: "tool_1", toolName: "webfetch", typedUsage: { durationMs: 1234 } },
      }),
    ], CTX);

    expect(result.events.map((event) => event.kind)).toEqual(["tool.started", "tool.progress", "tool.completed"]);
    expect(result.events[0]).toMatchObject({ kind: "tool.started", toolCallId: "tool_1", name: "webfetch", title: "Fetch quote" });
    expect(result.events[0]).not.toHaveProperty("input");
    expect(result.events[1]).toMatchObject({ kind: "tool.progress", toolCallId: "tool_1", preview: "Opening finance source" });
    expect(result.events[2]).toMatchObject({ kind: "tool.completed", toolCallId: "tool_1", status: "ok", preview: "Fetched current quote (1234ms)" });
  });

  test("creates synthetic start for terminal-only T3 tool frames so selectors keep the tool name", () => {
    const result = translateOpenCode([
      t3Frame("tool-done", 1, "t3.activity.tool.completed", {
        id: "act_tool_done",
        kind: "tool.completed",
        summary: "Fetched current quote",
        payload: { toolUseId: "tool_1", toolName: "webfetch" },
      }),
    ], CTX);

    expect(result.events.map((event) => event.kind)).toEqual(["tool.started", "tool.completed"]);
    expect(result.events[0]).toMatchObject({ kind: "tool.started", toolCallId: "tool_1", name: "webfetch" });
    expect(result.accounting[0]?.produced).toEqual(["tool.started", "tool.completed"]);
  });

  test("maps T3 agent task lifecycle to child events with stable task identity", () => {
    const result = translateOpenCode([
      t3Frame("task-start", 1, "t3.activity.task.started", {
        id: "act_task_start",
        kind: "task.started",
        summary: "Start price researcher",
        payload: { taskId: "task_1", agentKind: "agent", title: "Price researcher" },
      }),
      t3Frame("task-progress", 2, "t3.activity.task.progress", {
        id: "act_task_progress",
        kind: "task.progress",
        summary: "Checking Yahoo Finance",
        payload: { taskId: "task_1", agentKind: "agent", status: "running" },
      }),
      t3Frame("task-complete", 3, "t3.activity.task.completed", {
        id: "act_task_complete",
        kind: "task.completed",
        summary: "NVIDIA quote found",
        payload: { taskId: "task_1", agentKind: "agent" },
      }),
    ], CTX);

    expect(result.events.map((event) => event.kind)).toEqual(["child.started", "child.updated", "child.completed"]);
    expect(result.events[0]).toMatchObject({ kind: "child.started", childId: "task_1", title: "Price researcher" });
    expect(result.events[1]).toMatchObject({ kind: "child.updated", childId: "task_1", status: "Checking Yahoo Finance" });
    expect(result.events[2]).toMatchObject({ kind: "child.completed", childId: "task_1", status: "ok", result: "NVIDIA quote found" });
  });

  test("suppresses agent tasks that lack a provider child identity", () => {
    const result = translateOpenCode([
      t3Frame("task-start-missing-id", 1, "t3.activity.task.started", {
        id: "presentation-only-activity-id",
        kind: "task.started",
        summary: "Start price researcher",
        payload: { agentKind: "agent", title: "Price researcher" },
      }),
    ], CTX);

    expect(result.events).toEqual([]);
    expect(result.accounting[0]).toMatchObject({
      produced: [],
      suppressed: "t3 agent task without provider child identity",
    });
  });

  test("suppresses context-window diagnostics and duplicate collaboration wrappers explicitly", () => {
    const result = translateOpenCode([
      t3Frame("ctx", 1, "t3.activity.context-window.updated", {
        id: "ctx",
        kind: "context-window.updated",
        payload: { tokenCount: 12345 },
      }),
      t3Frame("task-start", 2, "t3.activity.task.started", {
        id: "act_task_start",
        kind: "task.started",
        payload: { taskId: "task_1", toolUseId: "tool_wrap_1", agentKind: "agent", title: "Researcher" },
      }),
      t3Frame("wrapper-start", 3, "t3.activity.tool.started", {
        id: "act_wrapper_start",
        kind: "tool.started",
        payload: { toolUseId: "tool_wrap_1", itemType: "collab_agent_tool_call", toolName: "subagent" },
      }),
    ], CTX);

    expect(result.events.map((event) => event.kind)).toEqual(["child.started"]);
    expect(result.accounting[0]).toMatchObject({ produced: [], suppressed: "t3 context-window diagnostic (not a timeline node)" });
    expect(result.accounting[2]).toMatchObject({ produced: [], suppressed: "duplicate t3 collaboration wrapper (task lifecycle is authoritative)" });
  });

  test("keeps standalone collaboration wrappers as child lifecycle events", () => {
    const result = translateOpenCode([
      t3Frame("wrapper-start", 1, "t3.activity.tool.started", {
        id: "act_wrapper_start",
        kind: "tool.started",
        summary: "Price researcher",
        payload: {
          toolUseId: "tool_wrap_2",
          childSessionId: "child_2",
          itemType: "collab_agent_tool_call",
          toolName: "subagent",
        },
      }),
      t3Frame("wrapper-progress", 2, "t3.activity.tool.progress", {
        id: "act_wrapper_progress",
        kind: "tool.progress",
        summary: "Checking the quote",
        payload: {
          toolUseId: "tool_wrap_2",
          childSessionId: "child_2",
          itemType: "collab_agent_tool_call",
        },
      }),
      t3Frame("wrapper-done", 3, "t3.activity.tool.completed", {
        id: "act_wrapper_done",
        kind: "tool.completed",
        summary: "Quote found",
        payload: {
          toolUseId: "tool_wrap_2",
          childSessionId: "child_2",
          itemType: "collab_agent_tool_call",
        },
      }),
    ], CTX);

    expect(result.events.map((event) => event.kind)).toEqual([
      "child.started",
      "child.updated",
      "child.completed",
    ]);
    expect(result.events[0]).toMatchObject({
      kind: "child.started",
      childId: "child_2",
      title: "Price researcher",
    });
    expect(result.events[2]).toMatchObject({
      kind: "child.completed",
      childId: "child_2",
      status: "ok",
      result: "Quote found",
    });
  });

  test("does not invent child identity from a standalone collaboration tool call", () => {
    const result = translateOpenCode([
      t3Frame("wrapper-only", 1, "t3.activity.tool.started", {
        id: "activity-only",
        kind: "tool.started",
        summary: "Price researcher",
        payload: {
          toolUseId: "tool-call-only",
          itemType: "collab_agent_tool_call",
          toolName: "subagent",
        },
      }),
    ], CTX);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "tool.started",
      toolCallId: "tool-call-only",
      name: "subagent",
    });
    expect(result.events[0]?.kind).not.toBe("child.started");
  });

  test("names T3 durable step replay events before completion", () => {
    const steps: OpenCodeStep[] = [{
      id: "step_t3_tool",
      idx: 0,
      kind: "command",
      label: "Fetch quote",
      chip: "webfetch",
      code_json: JSON.stringify({
        source: "t3",
        tool: "webfetch",
        output: "Fetched current quote",
        native: { callID: "tool_1", sessionID: "ses_t3" },
      }),
    }];

    const result = translateOpenCode([], { ...CTX, engine: "codex" }, steps);
    expect(result.events.map((event) => event.kind)).toEqual(["tool.started", "tool.completed"]);
    expect(result.events[0]).toMatchObject({
      kind: "tool.started",
      toolCallId: "tool_1",
      name: "webfetch",
      title: "Fetch quote",
      identity: { provider: "codex", nativeSessionId: "ses_t3" },
    });
    expect(result.events[1]).toMatchObject({
      kind: "tool.completed",
      toolCallId: "tool_1",
      preview: "Fetched current quote",
      identity: { provider: "codex", nativeSessionId: "ses_t3" },
    });
    expect(result.accounting[0]?.produced).toEqual(["tool.started", "tool.completed"]);
  });
});

describe("native question translation", () => {
  const questionFrames: OpenCodeFrame[] = [
    {
      eventId: "question-asked",
      seq: 1,
      provider: "opencode",
      eventType: "question.asked",
      native: { sessionId: "ses_p", parentSessionId: null, messageId: "m1", partId: null, callId: "call_q" },
      payload: {
        id: "que_1",
        sessionID: "ses_p",
        questions: [
          {
            header: "Target",
            question: "Where should I deploy?",
            options: [{ label: "Staging", description: "Safer" }],
            multiple: false,
            custom: false,
          },
        ],
      },
    },
    {
      eventId: "question-replied",
      seq: 2,
      provider: "opencode",
      eventType: "question.replied",
      native: { sessionId: "ses_p", parentSessionId: null, messageId: null, partId: null, callId: null },
      payload: { sessionID: "ses_p", requestID: "que_1", answers: [["Staging"]] },
    },
  ];

  test("preserves structured request and resolution", () => {
    const { events: translated, accounting: dispositions } = translateOpenCode(questionFrames, CTX);
    const asked = translated.find((event) => event.kind === "question.requested");
    const replied = translated.find((event) => event.kind === "question.resolved");
    expect(asked).toMatchObject({
      questionId: "que_1",
      prompt: "Where should I deploy?",
      options: ["Staging"],
    });
    expect(replied).toMatchObject({
      questionId: "que_1",
      answer: "Staging",
      answers: [["Staging"]],
      status: "answered",
    });
    expect(dispositions.every((item) => item.produced.length === 1)).toBe(true);
  });
});

describe("durable artifact translation", () => {
  const descriptor = {
    id: "a1",
    name: "report.pdf",
    size_bytes: 123,
    sha256: "f".repeat(64),
    content_type: "application/pdf",
  };

  test("maps lifecycle frames without losing immutable identity", () => {
    const artifactFrames: OpenCodeFrame[] = [
      {
        eventId: "artifact-created",
        seq: 1,
        provider: "skynet",
        eventType: "artifact.created",
        native: { sessionId: null, parentSessionId: null, messageId: null, partId: null, callId: null },
        payload: descriptor,
      },
      {
        eventId: "artifact-delivered",
        seq: 2,
        provider: "skynet",
        eventType: "artifact.delivered",
        native: { sessionId: null, parentSessionId: null, messageId: null, partId: null, callId: null },
        payload: { ...descriptor, destination: "slack" },
      },
    ];
    const result = translateOpenCode(artifactFrames, CTX);
    expect(result.events.map((event) => event.kind)).toEqual([
      "artifact.created",
      "artifact.delivered",
    ]);
    expect(result.events[0]).toMatchObject({
      kind: "artifact.created",
      name: "report.pdf",
      artifact: {
        artifactId: "a1",
        bytes: 123,
        sha256: "f".repeat(64),
        contentType: "application/pdf",
      },
    });
    expect(result.events[1]).toMatchObject({
      kind: "artifact.delivered",
      destination: "slack",
    });
    expect(result.accounting.every((entry) => entry.produced.length === 1)).toBe(true);
  });
});

describe("run-timing diagnostics are suppressed, never timeline nodes (perf Phase 0)", () => {
  const timingFrames: OpenCodeFrame[] = [
    {
      eventId: "run_test:timing:sandbox",
      seq: 1,
      provider: "skynet-timing",
      eventType: "timing.span",
      native: { sessionId: null, parentSessionId: null, messageId: null, partId: null, callId: null },
      payload: { stage: "sandbox", startedAt: 1000, endedAt: 1400, durMs: 400 },
    },
    {
      eventId: "run_test:timing:dispatch",
      seq: 2,
      provider: "skynet-timing",
      eventType: "timing.mark",
      native: { sessionId: null, parentSessionId: null, messageId: null, partId: null, callId: null },
      payload: { stage: "dispatch", at: 1500 },
    },
  ];

  test("timing frames produce ZERO canonical events (no harness.warning noise)", () => {
    const result = translateOpenCode(timingFrames, CTX);
    expect(result.events).toEqual([]);
  });

  test("suppression is ACCOUNTED with a named reason (lossless accounting holds)", () => {
    const result = translateOpenCode(timingFrames, CTX);
    expect(result.accounting.length).toBe(timingFrames.length);
    for (const d of result.accounting) {
      expect(d.produced).toEqual([]);
      expect(d.suppressed).toBe("run-timing diagnostic (not a timeline node)");
    }
  });
});
