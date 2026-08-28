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
    case "child.updated": case "child.completed": case "delegation.control":
    case "approval.requested":
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
      payload: { type: "tool", tool: "task", state: {
        status: "completed",
        title: "Research prices",
        input: { description: "Research prices", prompt: "Find Google price" },
        output: '<task id="ses_child1"><task_result>the answer</task_result></task>',
      } } },
    { eventId: "e2", seq: 2, provider: "opencode", eventType: "part.tool.error",
      native: { sessionId: "ses_p", parentSessionId: null, messageId: "m1", partId: "p2", callId: "call_2" },
      payload: { type: "tool", tool: "task", state: {
        status: "error",
        title: "Research prices",
        input: { description: "Research prices", prompt: "Find NVIDIA price" },
        output: '<task id="ses_child2"></task>',
      } } },
  ];
  test("task tool -> child.started + child.completed with derived id/result/status", () => {
    const { events: ev } = translateOpenCode(taskFrames, CTX);
    const done = ev.filter((e) => e.kind === "child.completed") as { childId: string; status: string; result?: string }[];
    expect(ev.filter((e) => e.kind === "child.started").length).toBe(2);
    expect(
      ev
        .filter((e) => e.kind === "child.started")
        .map((e) => e.kind === "child.started" ? [e.childId, e.title, e.state?.prompt] : null),
    ).toEqual([
      ["ses_child1", "Research prices", "Find Google price"],
      ["ses_child2", "Research prices", "Find NVIDIA price"],
    ]);
    const c1 = done.find((e) => e.childId === "ses_child1");
    expect(c1?.status).toBe("ok");
    expect(c1?.result).toBe("the answer");
    expect(done.find((e) => e.status === "error")).toBeTruthy();
  });

  test("uses the eventual child session id for every revision of one task call", () => {
    const frames: OpenCodeFrame[] = [
      {
        eventId: "task-running",
        seq: 1,
        provider: "opencode",
        eventType: "part.tool.updated",
        native: {
          sessionId: "ses_parent",
          parentSessionId: null,
          messageId: "m1",
          partId: "part-task",
          callId: "call-task",
        },
        payload: {
          type: "tool",
          tool: "task",
          state: { status: "running", input: { prompt: "Inspect the release" } },
        },
      },
      {
        eventId: "task-completed",
        seq: 2,
        provider: "opencode",
        eventType: "part.tool.completed",
        native: {
          sessionId: "ses_parent",
          parentSessionId: null,
          messageId: "m1",
          partId: "part-task",
          callId: "call-task",
        },
        payload: {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            output: '<task id="ses_real"><task_result>done</task_result></task>',
          },
        },
      },
    ];

    const childEvents = translateOpenCode(frames, CTX).events.filter(
      (event): event is Extract<
        CanonicalAgentEvent,
        { kind: "child.started" | "child.updated" | "child.completed" }
      > =>
        event.kind === "child.started" ||
        event.kind === "child.updated" ||
        event.kind === "child.completed",
    );
    expect(childEvents.map((event) => event.childId)).toEqual([
      "ses_real",
      "ses_real",
      "ses_real",
    ]);
    expect(childEvents.filter((event) => event.kind === "child.started")).toHaveLength(1);
    expect(childEvents.filter((event) => event.kind === "child.completed")).toHaveLength(1);
  });
});

// The opencode frames genuinely carry child state: session lifecycle title, task
// tool metadata (child sessionId, model.modelID, input.subagent_type) and child
// step-finish token/cost counters. These tests pin that the translator populates
// CanonicalChildState from those REAL fields (and only those - model/role stay
// absent when the frames omit them).
describe("opencode child state fidelity (real frame fields only)", () => {
  const child = (over: Partial<OpenCodeFrame["native"]> = {}): OpenCodeFrame["native"] => ({
    sessionId: "ses_child", parentSessionId: null, messageId: "m2", partId: "p_c", callId: null, ...over,
  });
  const taskState = {
    title: "Research pricing",
    input: { description: "Research pricing", prompt: "compare pages", subagent_type: "researcher" },
    metadata: { parentSessionId: "ses_p", sessionId: "ses_child", model: { modelID: "claude-sonnet-5", providerID: "anthropic" } },
  };
  const frames: OpenCodeFrame[] = [
    { eventId: "life", seq: 1, provider: "opencode", eventType: "session.created",
      native: { sessionId: "ses_child", parentSessionId: "ses_p", messageId: null, partId: null, callId: null },
      payload: { id: "ses_child", parentID: "ses_p", title: "Compare pricing pages" } },
    { eventId: "task-run", seq: 2, provider: "opencode", eventType: "part.tool.running",
      native: { sessionId: "ses_p", parentSessionId: null, messageId: "m1", partId: "p_t", callId: "call_1" },
      payload: { type: "tool", tool: "task", state: { status: "running", ...taskState } } },
    { eventId: "child-tool", seq: 3, provider: "opencode", eventType: "part.tool.completed",
      native: child({ partId: "p_w", callId: "call_w" }),
      payload: { type: "tool", tool: "webfetch", state: { status: "completed", title: "Fetch pricing page", output: "prices..." } } },
    { eventId: "finish-1", seq: 4, provider: "opencode", eventType: "part.step-finish",
      native: child({ partId: "p_f1" }),
      payload: { type: "step-finish", reason: "tool-calls", cost: 0.125, tokens: { input: 100, output: 40, reasoning: 8, cache: { read: 25, write: 5 } } } },
    { eventId: "finish-2", seq: 5, provider: "opencode", eventType: "part.step-finish",
      native: child({ partId: "p_f2" }),
      payload: { type: "step-finish", reason: "stop", cost: 0.125, tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } },
    { eventId: "task-done", seq: 6, provider: "opencode", eventType: "part.tool.completed",
      native: { sessionId: "ses_p", parentSessionId: null, messageId: "m1", partId: "p_t", callId: "call_1" },
      payload: { type: "tool", tool: "task", state: { status: "completed", ...taskState,
        output: '<task id="ses_child" state="completed"><task_result>done answer</task_result></task>' } } },
  ];
  const { events: ev } = translateOpenCode(frames, CTX);
  const updates = ev.filter((e) => e.kind === "child.updated");

  test("session-established child.started carries title + pre-scanned role/model", () => {
    expect(ev[0]).toMatchObject({
      kind: "child.started",
      childId: "ses_child",
      parentChildId: "ses_p",
      identity: {
        nativeSessionId: "ses_child",
        nativeParentSessionId: "ses_p",
      },
      title: "Compare pricing pages",
      state: { role: "researcher", model: "claude-sonnet-5" },
    });
  });

  test("child-owned activity retains its resolved native parent identity", () => {
    const childUpdate = ev.find(
      (event) => event.kind === "child.updated" && event.identity.nativePartId === "p_w",
    );
    expect(childUpdate).toMatchObject({
      kind: "child.updated",
      childId: "ses_child",
      identity: {
        nativeSessionId: "ses_child",
        nativeParentSessionId: "ses_p",
      },
    });
  });

  test("task launch resolves the child id from metadata.sessionId before any output marker", () => {
    const launch = ev.find((e) => e.kind === "child.started" && e.launchToolCallId === "call_1");
    expect(launch).toMatchObject({
      childId: "ses_child",
      title: "Research pricing",
      state: {
        status: "running",
        prompt: "compare pages",
        role: "researcher",
        model: "claude-sonnet-5",
      },
    });
  });

  test("child tool activity emits child.updated with real summary + lastToolName", () => {
    expect(updates.find((e) => e.identity.nativePartId === "p_w")).toMatchObject({
      childId: "ses_child",
      status: "Fetch pricing page",
      state: {
        summary: "Fetch pricing page",
        lastToolName: "webfetch",
        role: "researcher",
        model: "claude-sonnet-5",
      },
    });
  });

  test("child step-finish keeps message.completed AND accumulates cumulative typed usage", () => {
    expect(ev.filter((e) => e.kind === "message.completed" && e.messageId === "m2").length).toBe(2);
    const first = updates.find((e) => e.identity.nativePartId === "p_f1");
    const second = updates.find((e) => e.identity.nativePartId === "p_f2");
    expect(first?.kind === "child.updated" ? first.state?.usage : undefined).toEqual({
      inputTokens: 100, outputTokens: 40, reasoningOutputTokens: 8, cachedInputTokens: 25, costUsd: 0.125,
    });
    // cumulative totals, and the earlier emitted snapshot is NOT mutated by later frames
    expect(second?.kind === "child.updated" ? second.state?.usage : undefined).toEqual({
      inputTokens: 150, outputTokens: 50, reasoningOutputTokens: 8, cachedInputTokens: 25, costUsd: 0.25,
    });
  });

  test("child.completed carries the fully merged real state", () => {
    expect(ev.find((e) => e.kind === "child.completed")).toMatchObject({
      childId: "ses_child",
      status: "ok",
      result: "done answer",
      state: {
        status: "completed",
        summary: "Fetch pricing page",
        lastToolName: "webfetch",
        usage: { inputTokens: 150, outputTokens: 50, reasoningOutputTokens: 8, cachedInputTokens: 25, costUsd: 0.25 },
        role: "researcher",
        model: "claude-sonnet-5",
      },
    });
  });

  test("an empty (synthesized) step-finish fabricates no usage and no child.updated", () => {
    const result = translateOpenCode([
      { eventId: "life-2", seq: 1, provider: "opencode", eventType: "session.updated",
        native: { sessionId: "ses_kid", parentSessionId: "ses_p", messageId: null, partId: null, callId: null },
        payload: {} },
      { eventId: "finish-empty", seq: 2, provider: "opencode", eventType: "part.step-finish",
        native: { sessionId: "ses_kid", parentSessionId: null, messageId: "m9", partId: "p9", callId: null },
        payload: {} },
    ], CTX);
    expect(result.events.map((e) => e.kind)).toEqual(["child.started", "session.metadata", "message.completed"]);
    const started = result.events[0];
    expect(started).toMatchObject({ kind: "child.started", childId: "ses_kid", parentChildId: "ses_p" });
    expect(started?.kind === "child.started" ? started.state : null).toBeUndefined();
    expect(started?.kind === "child.started" ? started.title : null).toBeUndefined();
  });

  test("root-session tool parts and step-finish emit no child.updated", () => {
    const result = translateOpenCode([
      { eventId: "root-tool", seq: 1, provider: "opencode", eventType: "part.tool.completed",
        native: { sessionId: "ses_root", parentSessionId: null, messageId: "m1", partId: "p1", callId: "c1" },
        payload: { type: "tool", tool: "bash", state: { status: "completed", output: "ok" } } },
      { eventId: "root-finish", seq: 2, provider: "opencode", eventType: "part.step-finish",
        native: { sessionId: "ses_root", parentSessionId: null, messageId: "m1", partId: "p2", callId: null },
        payload: { type: "step-finish", cost: 0.1, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } } },
    ], CTX);
    expect(result.events.some((e) => e.kind === "child.updated")).toBe(false);
  });
});

describe("provider-neutral native lifecycle identity", () => {
  const providers = ["codex", "claude", "opencode", "pi", "acp"] as const;

  for (const provider of providers) {
    test(`${provider} tool lifecycle keeps provider and native call detail`, () => {
      const native = {
        sessionId: `${provider}-session`,
        parentSessionId: null,
        messageId: `${provider}-message`,
        partId: `${provider}-part`,
        callId: `${provider}-call`,
      };
      const result = translateOpenCode([
        {
          eventId: `${provider}-tool-start`,
          seq: 1,
          provider,
          eventType: "part.tool.running",
          native,
          payload: { type: "tool", tool: "shell" },
        },
        {
          eventId: `${provider}-tool-done`,
          seq: 2,
          provider,
          eventType: "part.tool.completed",
          native,
          payload: { type: "tool", tool: "shell" },
        },
      ], CTX);

      expect(result.events).toMatchObject([
        {
          kind: "tool.started",
          toolCallId: `${provider}-call`,
          name: "shell",
          identity: {
            provider,
            nativeSessionId: `${provider}-session`,
            nativeMessageId: `${provider}-message`,
            nativePartId: `${provider}-part`,
          },
        },
        {
          kind: "tool.completed",
          toolCallId: `${provider}-call`,
          status: "ok",
          identity: { provider },
        },
      ]);
    });

    test(`${provider} subagent lifecycle keeps the provider child identity`, () => {
      const result = translateOpenCode([{
        eventId: `${provider}-child-done`,
        seq: 1,
        provider,
        eventType: "part.tool.completed",
        native: {
          sessionId: `${provider}-parent`,
          parentSessionId: null,
          messageId: `${provider}-message`,
          partId: `${provider}-part`,
          callId: `${provider}-launch`,
        },
        payload: {
          type: "tool",
          tool: "task",
          title: "Research provider parity",
          state: {
            status: "completed",
            output: `<task id="ses_${provider}_child"><task_result>verified</task_result></task>`,
          },
        },
      }], CTX);

      expect(result.events).toMatchObject([
        {
          kind: "child.started",
          childId: `ses_${provider}_child`,
          launchToolCallId: `${provider}-launch`,
          identity: { provider, nativeSessionId: `${provider}-parent` },
        },
        {
          kind: "child.completed",
          childId: `ses_${provider}_child`,
          status: "ok",
          result: "verified",
          identity: { provider, nativeSessionId: `${provider}-parent` },
        },
      ]);
    });
  }

  test("an unknown native event remains accounted with provider and native identity", () => {
    const payload = { capability: "future-tool", detail: { version: 2 } };
    const result = translateOpenCode([{
      eventId: "pi-experimental-1",
      seq: 7,
      provider: "pi",
      eventType: "pi.experimental.capability",
      native: {
        sessionId: "pi-session",
        parentSessionId: null,
        messageId: "pi-message",
        partId: "pi-part",
        callId: "pi-call",
      },
      payload,
    }], CTX);

    expect(result.events).toMatchObject([{
      kind: "harness.warning",
      rawEventType: "pi.experimental.capability",
      rawPayload: payload,
      identity: {
        provider: "pi",
        nativeEventId: "pi-experimental-1",
        nativeSessionId: "pi-session",
        nativeSeq: 7,
        nativeMessageId: "pi-message",
        nativePartId: "pi-part",
      },
    }]);
    expect(result.accounting).toEqual([{
      sourceId: "pi-experimental-1",
      kind: "pi.experimental.capability",
      provider: "pi",
      produced: ["harness.warning"],
    }]);
  });
});

describe("OpenCode native todowrite plans", () => {
  test("maps a valid native todowrite frame to a canonical plan without a generic tool row", () => {
    const result = translateOpenCode([{
      eventId: "todo-frame",
      seq: 1,
      provider: "opencode",
      eventType: "part.tool.completed",
      native: {
        sessionId: "ses-plan",
        parentSessionId: null,
        messageId: "msg-plan",
        partId: "part-plan",
        callId: "call-plan",
      },
      payload: {
        tool: "todowrite",
        state: {
          input: {
            todos: [
              { id: "inspect", content: "Inspect flow", status: "completed" },
              { id: "verify", content: "Verify UI", status: "in_progress" },
            ],
          },
        },
      },
    }], CTX);

    expect(result.events).toMatchObject([{
      kind: "plan.updated",
      entries: [
        { id: "inspect", text: "Inspect flow", status: "completed" },
        { id: "verify", text: "Verify UI", status: "in_progress" },
      ],
    }]);
    expect(result.events.some((event) => event.kind.startsWith("tool."))).toBe(false);
    expect(result.accounting[0]?.produced).toEqual(["plan.updated"]);
  });

  test("maps each valid durable snapshot to plan.updated and keeps provider item ids", () => {
    const steps: OpenCodeStep[] = [
      {
        id: "plan-1",
        idx: 1,
        kind: "command",
        code_json: JSON.stringify({
          tool: "todowrite",
          input: { todos: [{ id: "one", content: "First", status: "in_progress" }] },
        }),
      },
      {
        id: "plan-2",
        idx: 2,
        kind: "command",
        code_json: JSON.stringify({
          tool: "todowrite",
          input: {
            todos: [
              { id: "one", content: "First", status: "completed" },
              { id: "two", content: "Second", status: "pending" },
            ],
          },
        }),
      },
    ];
    const result = translateOpenCode([], CTX, steps);

    expect(result.events.map((event) => event.kind)).toEqual(["plan.updated", "plan.updated"]);
    expect(result.events[1]).toMatchObject({
      entries: [
        { id: "one", text: "First", status: "completed" },
        { id: "two", text: "Second", status: "pending" },
      ],
    });
  });

  test("keeps malformed or empty todowrite payloads on the existing generic tool path", () => {
    const steps: OpenCodeStep[] = [
      {
        id: "empty-plan",
        idx: 1,
        kind: "command",
        code_json: JSON.stringify({ tool: "todowrite", input: { todos: [] } }),
      },
      {
        id: "malformed-plan",
        idx: 2,
        kind: "command",
        code_json: JSON.stringify({ tool: "todowrite", input: { todos: "invalid" } }),
      },
    ];
    const result = translateOpenCode([], CTX, steps);

    expect(result.events.map((event) => event.kind)).toEqual(["tool.completed", "tool.completed"]);
    expect(result.events.some((event) => event.kind === "plan.updated")).toBe(false);
  });
});

describe("T3 activity fidelity", () => {
  const t3Frame = (
    eventId: string,
    seq: number,
    eventType: string,
    payload: unknown,
    callId: string | null = null,
    native: Partial<OpenCodeFrame["native"]> = {},
  ): OpenCodeFrame => ({
    eventId,
    seq,
    provider: "t3",
    eventType,
    native: {
      sessionId: "ses_t3",
      parentSessionId: null,
      messageId: null,
      partId: null,
      callId,
      ...native,
    },
    payload,
  });

  test("does not expose transport placeholders as canonical tool names", () => {
    for (const [index, placeholder] of ["task", "mcp tool call"].entries()) {
      const result = translateOpenCode([
        t3Frame(`placeholder-${index}`, index + 1, "t3.activity.tool.completed", {
          id: `activity-${index}`,
          kind: "tool.completed",
          summary: placeholder,
          payload: {
            data: { item: { id: `call-${index}`, toolName: placeholder } },
          },
        }),
      ], CTX);

      expect(result.events).toMatchObject([
        { kind: "tool.started", name: "tool" },
        { kind: "tool.completed", toolCallId: `call-${index}` },
      ]);
    }
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
    expect(result.events[2]).toMatchObject({
      kind: "tool.completed",
      toolCallId: "tool_1",
      status: "ok",
      preview: "Fetched current quote",
      durationMs: 1234,
    });
  });

  test("preserves nested MCP identity, status, result, and duration without exposing arguments", () => {
    const result = translateOpenCode([
      t3Frame("mcp-done", 1, "t3.activity.tool.completed", {
        id: "activity-mcp-done",
        kind: "tool.completed",
        summary: "Create the pull request",
        payload: {
          itemType: "mcp_tool_call",
          data: {
            item: {
              id: "call-pr-1",
              server: "github",
              toolName: "create_pull_request",
              arguments: { title: "Preserve canonical fidelity" },
              status: "completed",
              result: "pull request #42 created",
              durationMs: 1_234,
            },
          },
        },
      }),
    ], CTX);

    expect(result.events).toMatchObject([
      {
        kind: "tool.started",
        toolCallId: "call-pr-1",
        name: "create_pull_request",
        server: "github",
      },
      {
        kind: "tool.completed",
        toolCallId: "call-pr-1",
        status: "ok",
        nativeStatus: "completed",
        preview: "pull request #42 created",
        durationMs: 1_234,
      },
    ]);
    expect(result.events[0]).not.toHaveProperty("input");
  });

  test("preserves nested provider failure status and error detail", () => {
    const result = translateOpenCode([
      t3Frame("mcp-error", 1, "t3.activity.tool.completed", {
        id: "activity-mcp-error",
        kind: "tool.completed",
        summary: "Create the pull request",
        payload: {
          itemType: "mcp_tool_call",
          data: {
            item: {
              id: "call-pr-error",
              server: "github",
              toolName: "create_pull_request",
              status: "failed",
              error: "permission denied",
            },
          },
        },
      }),
    ], CTX);

    expect(result.events.at(-1)).toMatchObject({
      kind: "tool.completed",
      toolCallId: "call-pr-error",
      status: "error",
      nativeStatus: "failed",
      preview: "permission denied",
      error: "permission denied",
    });
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

  test("links placeholder child wrappers to a richly named completed task", () => {
    const result = translateOpenCode([
      t3Frame("collab-start", 1, "t3.activity.tool.started", {
        id: "act_collab_start",
        kind: "tool.started",
        summary: "Tool started",
        payload: {
          itemType: "collab_agent_tool_call",
          childSessionId: "google_price",
          data: { toolCallId: "call-1" },
        },
      }),
      t3Frame("task-start", 2, "t3.activity.task.started", {
        id: "act_task_start",
        kind: "task.started",
        summary: "Tool started",
        payload: {
          taskId: "google_price",
          toolUseId: "call-1",
          agentKind: "agent",
          title: "Tool",
          data: {
            item: {
              status: "running",
              summary: "Checking market data",
              model: "gpt-5.6-luna",
              role: "researcher",
              typedUsage: { inputTokens: 10, outputTokens: 2 },
            },
          },
        },
      }),
      t3Frame("task-complete", 3, "t3.activity.task.completed", {
        id: "act_task_complete",
        kind: "task.completed",
        summary: "Tool completed",
        payload: {
          taskId: "google_price",
          toolUseId: "call-1",
          agentKind: "agent",
          detail: '<task id="google_price"><task_result>NVIDIA quote found</task_result></task>',
          status: "completed",
        },
      }),
    ], CTX);

    expect(result.accounting[0]).toMatchObject({
      produced: [],
      suppressed: "duplicate t3 collaboration wrapper (task lifecycle is authoritative)",
    });
    expect(result.events).toMatchObject([
      {
        kind: "child.started",
        childId: "google_price",
        launchToolCallId: "call-1",
        title: "google price",
        state: {
          status: "running",
          summary: "Checking market data",
          model: "gpt-5.6-luna",
          role: "researcher",
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      },
      {
        kind: "child.completed",
        childId: "google_price",
        status: "ok",
        result: "NVIDIA quote found",
      },
    ]);
  });

  test("preserves structured provider child state without deriving it from summary words", () => {
    const result = translateOpenCode([
      t3Frame("task-start", 1, "t3.activity.task.started", {
        id: "act_task_start",
        kind: "task.started",
        summary: "Research delegation accepted",
        payload: {
          taskId: "task_structured",
          agentKind: "agent",
          status: "running",
          summary: "Provider assigned the child",
          lastToolName: "web_search",
          typedUsage: { inputTokens: 12, outputTokens: 3, providerCacheReads: 4 },
          cost: 0.031,
          model: "gpt-5.6-luna",
          role: "researcher",
          resumable: true,
        },
      }),
      t3Frame("task-idle", 2, "t3.activity.task.progress", {
        id: "act_task_idle",
        kind: "task.progress",
        summary: "This sentence contains no lifecycle keyword",
        payload: {
          taskId: "task_structured",
          agentKind: "agent",
          status: "idle",
          summary: "Awaiting another turn",
          lastToolName: "browser",
          typedUsage: { totalTokens: 21, inputTokens: 16, outputTokens: 5 },
          model: "gpt-5.6-luna",
          role: "researcher",
          resumable: true,
        },
      }),
    ], CTX);

    expect(result.events).toMatchObject([
      {
        kind: "child.started",
        childId: "task_structured",
        state: {
          status: "running",
          summary: "Provider assigned the child",
          lastToolName: "web_search",
          usage: { inputTokens: 12, outputTokens: 3, providerCacheReads: 4, costUsd: 0.031 },
          model: "gpt-5.6-luna",
          role: "researcher",
          resumable: true,
        },
      },
      {
        kind: "child.updated",
        childId: "task_structured",
        status: "Awaiting another turn",
        state: {
          status: "idle",
          summary: "Awaiting another turn",
          lastToolName: "browser",
          usage: { totalTokens: 21, inputTokens: 16, outputTokens: 5 },
          model: "gpt-5.6-luna",
          role: "researcher",
          resumable: true,
        },
      },
    ]);
  });

  test("structured T3 child ownership does not duplicate its lifecycle start", () => {
    const result = translateOpenCode([
      t3Frame("task-start-owned", 1, "t3.activity.task.started", {
        id: "act-task-owned",
        kind: "task.started",
        payload: {
          taskId: "child-owned",
          parentAgentId: "root-owned",
          agentKind: "agent",
          status: "running",
        },
      }, null, {
        sessionId: "child-owned",
        parentSessionId: "root-owned",
      }),
    ], CTX);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "child.started",
      childId: "child-owned",
      identity: {
        nativeSessionId: "child-owned",
        nativeParentSessionId: "root-owned",
      },
    });
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
          delegationKind: "spawn",
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
          delegationKind: "spawn",
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
          delegationKind: "spawn",
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

  test("wait/send/resume/close remain parent-owned control events", () => {
    for (const [index, delegationKind] of ["wait", "send", "resume", "close"].entries()) {
      const targetChildIds = delegationKind === "wait"
        ? ["child-control", "child-control-2"]
        : ["child-control"];
      const result = translateOpenCode([
        t3Frame(`control-${delegationKind}`, index + 1, "t3.activity.tool.completed", {
          id: `activity-${delegationKind}`,
          kind: "tool.completed",
          summary: `${delegationKind} agent`,
          payload: {
            toolUseId: `control-${delegationKind}`,
            childSessionId: "child-control",
            ...(delegationKind === "wait" ? { receiverThreadIds: targetChildIds } : {}),
            delegationKind,
            itemType: "collab_agent_tool_call",
            toolName: delegationKind,
          },
        }),
      ], CTX);

      expect(result.events.some((event) => event.kind.startsWith("child."))).toBe(false);
      expect(result.events.map((event) => event.kind)).toEqual([
        "tool.started",
        "tool.completed",
        "delegation.control",
      ]);
      expect(result.events[0]).toMatchObject({
        kind: "tool.started",
        toolCallId: `control-${delegationKind}`,
      });
      expect(result.events[2]).toMatchObject({
        kind: "delegation.control",
        delegationKind,
        toolCallId: `control-${delegationKind}`,
        targetChildIds,
        status: "ok",
      });
    }
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

  test("uses provider activity as the single lifecycle when the durable T3 step is also present", () => {
    const frames = [
      t3Frame("tool-start", 1, "t3.activity.tool.started", {
        kind: "tool.started",
        summary: "Fetch quote",
        payload: { toolUseId: "tool_1", toolName: "webfetch" },
      }),
      t3Frame("tool-done", 2, "t3.activity.tool.completed", {
        kind: "tool.completed",
        summary: "Fetched current quote",
        payload: { toolUseId: "tool_1", toolName: "webfetch" },
      }),
    ];
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

    const result = translateOpenCode(frames, { ...CTX, engine: "codex" }, steps);
    expect(result.events.map((event) => event.kind)).toEqual(["tool.started", "tool.completed"]);
    expect(result.accounting.at(-1)).toMatchObject({
      sourceId: "step_t3_tool",
      produced: [],
      suppressed: "t3 provider activity lifecycle is authoritative",
    });
  });

  test("uses nested T3 producer call identity across activity revisions and durable replay", () => {
    const frames = [
      t3Frame("activity-start", 1, "t3.activity.tool.started", {
        id: "presentation-start",
        kind: "tool.started",
        summary: "Fetch quote",
        payload: {
          data: { toolCallId: "call-real", toolName: "webfetch" },
        },
      }),
      t3Frame("activity-done", 2, "t3.activity.tool.completed", {
        id: "presentation-done",
        kind: "tool.completed",
        summary: "Fetched quote",
        payload: {
          data: { toolCallId: "call-real", toolName: "webfetch" },
        },
      }),
    ];
    const steps: OpenCodeStep[] = [{
      id: "step-real-tool",
      idx: 0,
      kind: "command",
      label: "Fetch quote",
      code_json: JSON.stringify({
        source: "t3",
        tool: "webfetch",
        native: { callID: "call-real", sessionID: "ses_t3" },
      }),
    }];

    const result = translateOpenCode(frames, { ...CTX, engine: "codex" }, steps);
    expect(result.events.map((event) => event.kind)).toEqual(["tool.started", "tool.completed"]);
    expect(result.events).toMatchObject([
      { kind: "tool.started", toolCallId: "call-real" },
      { kind: "tool.completed", toolCallId: "call-real" },
    ]);
    expect(result.accounting.at(-1)).toMatchObject({
      sourceId: "step-real-tool",
      produced: [],
      suppressed: "t3 provider activity lifecycle is authoritative",
    });
  });

  test("mirrors durable T3 tool-call identity precedence for every supported shape", () => {
    const identityCases = [
      {
        name: "payload.toolCallId",
        activityId: "activity-payload-tool-call",
        payload: {
          toolCallId: "payload-call",
          data: { item: { id: "item-call" } },
        },
        expected: "payload-call",
      },
      {
        name: "data.toolCallId",
        activityId: "activity-data-tool-call",
        payload: {
          toolCallId: "payload-call",
          data: { toolCallId: "data-call", item: { id: "item-call" } },
        },
        expected: "data-call",
      },
      {
        name: "data.item.id",
        activityId: "activity-item-id",
        payload: {
          toolUseId: "tool-use-call",
          data: { item: { id: "item-call" } },
        },
        expected: "item-call",
      },
      {
        name: "activity id fallback",
        activityId: "fallback-activity",
        payload: { detail: "identity-free native activity" },
        expected: "fallback-activity",
      },
    ] as const;

    for (const [index, identityCase] of identityCases.entries()) {
      const result = translateOpenCode([
        t3Frame(`frame-${identityCase.name}`, index + 1, "t3.activity.tool.completed", {
          id: identityCase.activityId,
          kind: "tool.completed",
          summary: identityCase.name,
          payload: identityCase.payload,
        }),
      ], CTX);
      expect(result.events).toMatchObject([
        { kind: "tool.started", toolCallId: identityCase.expected },
        { kind: "tool.completed", toolCallId: identityCase.expected },
      ]);
    }
  });

  test("uses agent task activity as the single lifecycle over its durable task replay", () => {
    const frames = [
      t3Frame("task-start", 1, "t3.activity.task.started", {
        id: "presentation-task-start",
        kind: "task.started",
        payload: { taskId: "task-real", agentKind: "agent", title: "Researcher" },
      }),
      t3Frame("task-done", 2, "t3.activity.task.completed", {
        id: "presentation-task-done",
        kind: "task.completed",
        summary: "Quote found",
        payload: { taskId: "task-real", agentKind: "agent" },
      }),
    ];
    const steps: OpenCodeStep[] = [{
      id: "step-real-task",
      idx: 0,
      kind: "task",
      label: "Researcher",
      code_json: JSON.stringify({
        source: "t3",
        tool: "subagent",
        native: { callID: "task-real", sessionID: "task-real" },
      }),
    }];

    const result = translateOpenCode(frames, { ...CTX, engine: "codex" }, steps);
    expect(result.events.map((event) => event.kind)).toEqual(["child.started", "child.completed"]);
    expect(result.events).toMatchObject([
      { kind: "child.started", childId: "task-real" },
      { kind: "child.completed", childId: "task-real" },
    ]);
    expect(result.accounting.at(-1)).toMatchObject({
      sourceId: "step-real-task",
      produced: [],
      suppressed: "t3 provider activity lifecycle is authoritative",
    });
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
