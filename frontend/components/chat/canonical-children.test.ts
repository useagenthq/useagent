import { describe, expect, test } from "bun:test";
import {
  type CanonicalChildEventLike,
  deriveCanonicalChildren,
  deriveChildrenView,
  deriveChildTimeline,
  legacySpawnStepIdForCanonical,
  remapCanonicalOwnerByStep,
} from "./canonical-children";
import type { CanonicalEventLike } from "./canonical-timeline";
import type { NativeFrame } from "./native-events";
import type { SubagentModel } from "./subagents";
import type { ApiStep } from "./types";

const event = (
  kind: CanonicalEventLike["kind"],
  seq: number,
  fields: Partial<CanonicalChildEventLike>,
): CanonicalChildEventLike => ({ kind, seq, ts: 1_000 + seq * 100, ...fields });

describe("canonical child projection", () => {
  test("folds one durable child lifecycle into a truthful card and fidelity record", () => {
    const model = deriveCanonicalChildren([
      event("child.started", 1, {
        childId: "child-1",
        launchToolCallId: "tool-1",
        title: "Check checkout validation",
      }),
      event("child.updated", 2, { childId: "child-1", status: "Running focused tests" }),
      event("child.completed", 3, {
        childId: "child-1",
        status: "ok",
        result: "Validation suite passed.",
      }),
    ]);

    expect(model.cards).toHaveLength(1);
    expect(model.cards[0]).toMatchObject({
      id: "canonical-child-child-1",
      title: "Check checkout validation",
      childSessionId: "child-1",
      callId: "tool-1",
      aliases: ["tool-1", "child-1"],
      status: "Running focused tests",
      startedAt: 1_100,
      lastActivityAt: 1_300,
    });
    expect(model.fidelity.get("child-1")).toMatchObject({
      callId: "tool-1",
      childSessionId: "child-1",
      status: "completed",
      progress: "Running focused tests",
      resultText: "Validation suite passed.",
    });
  });

  test("ignores orphan progress before child.started establishes durable identity", () => {
    const model = deriveCanonicalChildren([
      event("child.updated", 1, { childId: "orphan", status: "running" }),
    ]);

    expect(model.cards).toEqual([]);
    expect(model.fidelity.size).toBe(0);
  });

  test("synthesizes a truthful card from terminal-only child completion", () => {
    const model = deriveCanonicalChildren([
      event("child.completed", 1, {
        childId: "task-late-1",
        status: "ok",
        result: "Late task finished.",
        state: {
          status: "completed",
          summary: "Archived the final result",
          model: "gpt-5.6-luna",
          role: "executor",
          resumable: false,
        },
      }),
    ]);

    expect(model.cards).toEqual([{
      id: "canonical-child-task-late-1",
      title: "executor",
      childSessionId: "task-late-1",
      callId: "task-late-1",
      aliases: ["task-late-1"],
      status: "Late task finished.",
      startedAt: 1_100,
      lastActivityAt: 1_100,
    }]);
    expect(model.fidelity.get("task-late-1")).toMatchObject({
      callId: "task-late-1",
      childSessionId: "task-late-1",
      status: "completed",
      resultText: "Late task finished.",
      progress: "Archived the final result",
      model: "gpt-5.6-luna",
      role: "executor",
      resumable: false,
    });
    expect(model.fidelity.get("task-late-1")?.recentActivity).toEqual([
      { at: new Date(1_100).toISOString(), summary: "Archived the final result" },
      { at: new Date(1_100).toISOString(), summary: "Late task finished." },
    ]);
  });

  test("keeps siblings independent and maps terminal errors without parent-liveness guesses", () => {
    const model = deriveCanonicalChildren([
      event("child.started", 1, { childId: "a", title: "Alpha" }),
      event("child.started", 2, { childId: "b", title: "Beta" }),
      event("child.updated", 3, { childId: "a", status: "waiting" }),
      event("child.completed", 4, { childId: "b", status: "error", result: "quota" }),
    ]);

    expect(model.fidelity.get("a")?.status).toBe("waiting");
    expect(model.fidelity.get("b")?.status).toBe("failed");
    expect(model.fidelity.get("b")?.resultText).toBe("quota");
  });

  test("never lets a shared launch alias overwrite sibling status or result", () => {
    const events = [
      event("child.started", 1, { childId: "a", launchToolCallId: "shared-launch" }),
      event("child.started", 2, { childId: "b", launchToolCallId: "shared-launch" }),
      event("child.completed", 3, { childId: "a", status: "ok", result: "A" }),
      event("child.completed", 4, { childId: "b", status: "error", result: "B" }),
    ];

    const canonical = deriveCanonicalChildren(events);
    expect(canonical.fidelity.has("shared-launch")).toBe(false);
    expect(canonical.fidelity.get("a")).toMatchObject({ status: "completed", resultText: "A" });
    expect(canonical.fidelity.get("b")).toMatchObject({ status: "failed", resultText: "B" });

    const view = deriveChildrenView([], [], events);
    expect(view.fidelity.has("shared-launch")).toBe(false);
    expect(view.fidelity.get("a")).toMatchObject({ status: "completed", resultText: "A" });
    expect(view.fidelity.get("b")).toMatchObject({ status: "failed", resultText: "B" });
  });

  test("records completion result as real child activity instead of an empty zero-activity card", () => {
    const model = deriveCanonicalChildren([
      event("child.started", 1, {
        childId: "child-1",
        launchToolCallId: "tool-1",
        title: "Check checkout validation",
      }),
      event("child.completed", 2, {
        childId: "child-1",
        status: "ok",
        result: "Validation suite passed.",
      }),
    ]);

    expect(model.cards[0]).toMatchObject({
      status: "Validation suite passed.",
      lastActivityAt: 1_200,
    });
    expect(model.fidelity.get("child-1")?.recentActivity).toEqual([
      { at: new Date(1_200).toISOString(), summary: "Validation suite passed." },
    ]);
  });

  test("prefers structured child state and keeps provider metadata without keyword inference", () => {
    const started = event("child.started", 1, {
      childId: "child-structured",
      title: "Researcher",
      state: {
        status: "running",
        summary: "Provider assigned the child",
        prompt: "Verify checkout end to end",
        lastToolName: "web_search",
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          reasoningOutputTokens: 2,
          providerCacheReads: 4,
          costUsd: 0.013,
        },
        model: "gpt-5.6-luna",
        role: "researcher",
        resumable: true,
      },
    });
    expect(deriveCanonicalChildren([started]).fidelity.get("child-structured")?.usage).toEqual({
      totalTokens: 17,
      inputTokens: 12,
      outputTokens: 3,
      reasoningOutputTokens: 2,
      costUsd: 0.013,
    });

    const model = deriveCanonicalChildren([
      started,
      event("child.updated", 2, {
        childId: "child-structured",
        status: "This sentence contains no lifecycle keyword",
        state: {
          status: "idle",
          summary: "Awaiting another turn",
          lastToolName: "browser",
          usage: { totalTokens: 21, inputTokens: 16, outputTokens: 5 },
          resumable: true,
        },
      }),
    ]);

    expect(model.cards[0]).toMatchObject({ status: "Awaiting another turn" });
    expect(model.fidelity.get("child-structured")).toMatchObject({
      status: "idle",
      progress: "Awaiting another turn",
      prompt: "Verify checkout end to end",
      lastToolName: "browser",
      usage: { totalTokens: 21, inputTokens: 16, outputTokens: 5, costUsd: 0.013 },
      model: "gpt-5.6-luna",
      role: "researcher",
      resumable: true,
    });
  });

  test("keeps legacy child.updated strings backward compatible when structured state is absent", () => {
    const model = deriveCanonicalChildren([
      event("child.started", 1, { childId: "legacy-child" }),
      event("child.updated", 2, { childId: "legacy-child", status: "waiting" }),
    ]);

    expect(model.fidelity.get("legacy-child")).toMatchObject({
      status: "waiting",
      progress: "waiting",
    });
  });

  test("remaps exact native step ownership onto stable canonical card ids", () => {
    const canonical = deriveCanonicalChildren([
      event("child.started", 1, {
        childId: "child-1",
        launchToolCallId: "call-1",
        title: "Research checkout",
      }),
    ]);
    const legacy: SubagentModel = {
      cards: [{
        id: "legacy-spawn-step",
        title: "Research checkout",
        childSessionId: "child-1",
        callId: "call-1",
        aliases: ["call-1", "child-1"],
        status: "Read package.json",
        startedAt: 1_000,
        lastActivityAt: 1_500,
      }],
      ownerByStep: new Map([["child-tool-step", "legacy-spawn-step"]]),
    };

    expect(remapCanonicalOwnerByStep(canonical.cards, legacy)).toEqual(
      new Map([["child-tool-step", "canonical-child-child-1"]]),
    );
    const [canonicalCard] = canonical.cards;
    if (!canonicalCard) throw new Error("expected canonical child card");
    expect(legacySpawnStepIdForCanonical(canonicalCard, legacy)).toBe("legacy-spawn-step");
  });
});

const step = (id: string, code: Record<string, unknown>): ApiStep => ({
  id,
  run_id: "run-1",
  idx: 1,
  kind: "command",
  label: "↳ bash",
  chip: null,
  code_json: JSON.stringify(code),
  created_at: "2026-08-20T09:00:00Z",
});

const taskFrame = (over: Partial<NativeFrame> = {}): NativeFrame => ({
  schemaVersion: 1,
  eventId: "fr-1",
  seq: 1,
  provider: "opencode",
  eventType: "part.tool.completed",
  native: {
    sessionId: "ses_parent",
    parentSessionId: null,
    messageId: null,
    partId: "p1",
    callId: "call-1",
  },
  payload: {
    type: "tool",
    tool: "task",
    state: {
      output: '<task id="ses_child">done</task>\n<task_result>\nAll tests green.\n</task_result>',
    },
  },
  ...over,
});

describe("deriveChildrenView (the ONE merged rail + fold projection)", () => {
  test("canonical cards keep canonical metadata while the native lane fills the result", () => {
    const view = deriveChildrenView(
      [],
      [taskFrame()],
      [
        event("child.started", 1, {
          childId: "ses_child",
          launchToolCallId: "call-1",
          title: "Verify the suite",
          state: {
            status: "running",
            prompt: "Verify the focused suite",
            role: "verifier",
            model: "gpt-5.6-luna",
          },
        }),
      ],
    );

    expect(view.cards).toHaveLength(1);
    const fidelity = view.fidelity.get("ses_child");
    if (!fidelity) throw new Error("expected merged fidelity for ses_child");
    expect(fidelity).toMatchObject({
      role: "verifier",
      model: "gpt-5.6-luna",
      prompt: "Verify the focused suite",
      resultText: "All tests green.",
    });
    // The native lane saw the task COMPLETE; a canonical child that never saw
    // its completion frame adopts the terminal truth instead of running forever.
    expect(fidelity.status).toBe("completed");
    // Same record under every alias (call id + child session id).
    expect(view.fidelity.get("call-1")).toBe(fidelity);
  });

  test("attributes durable steps to canonical cards by native child session when legacy has no card", () => {
    const view = deriveChildrenView(
      [step("s-child-1", { tool: "bash", native: { sessionID: "ses_child" } })],
      [],
      [event("child.started", 1, { childId: "ses_child", title: "Child" })],
    );

    expect(view.ownerByStep.get("s-child-1")).toBe("canonical-child-ses_child");
  });

  test("attributes gateway-child durable steps by product run id", () => {
    const childStep = {
      ...step("s-gateway-child", { tool: "bash" }),
      run_id: "child-run-1",
    };
    const view = deriveChildrenView(
      [childStep],
      [],
      [event("child.started", 1, { childId: "child-run-1", title: "Research price" })],
    );

    expect(view.ownerByStep.get("s-gateway-child")).toBe("canonical-child-child-run-1");
  });

  test("falls back to the pure legacy projection when no canonical children exist", () => {
    const view = deriveChildrenView([], [taskFrame()], []);
    expect(view.cards).toEqual([]);
    expect(view.fidelity.get("call-1")).toMatchObject({
      status: "completed",
      resultText: "All tests green.",
    });
  });
});

describe("deriveChildTimeline (the subagent pane's real activity)", () => {
  const childEvents = (): CanonicalChildEventLike[] => [
    event("tool.started", 1, {
      toolCallId: "c1",
      name: "bash",
      title: "bun test checkout",
      identity: { nativeEventId: "step-a", nativeSessionId: "ses_child", nativeSeq: 1 },
    }),
    event("tool.completed", 2, {
      toolCallId: "c1",
      status: "ok",
      preview: "12 pass",
      identity: { nativeEventId: "step-a", nativeSessionId: "ses_child", nativeSeq: 2 },
    }),
    event("message.delta", 3, {
      messageId: "m1",
      text: "Checkout validation holds.",
      identity: { nativeSessionId: "ses_child", nativePartId: "pt1", nativeSeq: 3 },
    }),
    event("tool.started", 4, {
      toolCallId: "root-tool",
      name: "read",
      identity: { nativeEventId: "step-r", nativeSessionId: "ses_root", nativeSeq: 4 },
    }),
  ];

  test("folds the child's own tool lifecycles and text, excluding other sessions", () => {
    const timeline = deriveChildTimeline(childEvents(), new Map(), "ses_child");
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ kind: "tool", key: "canonical-tool-c1" });
    expect(timeline[1]).toMatchObject({ kind: "text", text: "Checkout validation holds." });
  });

  test("prefers authoritative completed text over deltas from the same child message", () => {
    const timeline = deriveChildTimeline(
      [
        event("message.delta", 1, {
          messageId: "m-final",
          text: "partial",
          identity: { nativeSessionId: "ses_child", nativePartId: "p-final" },
        }),
        event("message.completed", 2, {
          messageId: "m-final",
          text: "complete answer",
          identity: { nativeSessionId: "ses_child", nativePartId: "p-final" },
        }),
      ],
      new Map(),
      "ses_child",
    );

    expect(timeline).toEqual([
      { kind: "text", key: "child-text-m-final", text: "complete answer" },
    ]);
  });

  test("prefers the durable sidecar step over the projected lifecycle", () => {
    const durable = step("step-a", { tool: "bash", output: "12 pass, 0 fail" });
    const timeline = deriveChildTimeline(
      childEvents(),
      new Map([["step-a", durable]]),
      "ses_child",
    );
    expect(timeline[0]).toMatchObject({ kind: "tool", key: "step-a", step: durable });
  });

  test("folds gateway-child events by product run id even when native session differs", () => {
    const timeline = deriveChildTimeline(
      [
        event("tool.started", 1, {
          runId: "child-run-1",
          toolCallId: "c1",
          name: "webfetch",
          title: "Fetch market quote",
          identity: { nativeSessionId: "provider-session-9", nativeSeq: 1 },
        }),
        event("tool.completed", 2, {
          runId: "child-run-1",
          toolCallId: "c1",
          status: "ok",
          preview: "Quote fetched",
          identity: { nativeSessionId: "provider-session-9", nativeSeq: 2 },
        }),
        event("message.delta", 3, {
          runId: "child-run-1",
          messageId: "m1",
          text: "GOOGL is $344.82.",
          identity: { nativeSessionId: "provider-session-9", nativePartId: "p1" },
        }),
      ],
      new Map(),
      "child-run-1",
    );

    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ kind: "tool" });
    expect(timeline[1]).toMatchObject({ kind: "text", text: "GOOGL is $344.82." });
  });

  test("yields nothing without a child session identity", () => {
    expect(deriveChildTimeline(childEvents(), new Map(), null)).toEqual([]);
  });

  test("drops empty generic collaboration wrappers from child detail", () => {
    const timeline = deriveChildTimeline(
      [
        event("tool.started", 1, {
          toolCallId: "wrapper",
          name: "collab_agent_tool_call",
          title: "Tool started",
          identity: { nativeSessionId: "ses_child", nativeSeq: 1 },
        }),
        event("tool.completed", 2, {
          toolCallId: "wrapper",
          status: "ok",
          preview: "Tool",
          identity: { nativeSessionId: "ses_child", nativeSeq: 2 },
        }),
      ],
      new Map(),
      "ses_child",
    );

    expect(timeline).toEqual([]);
  });

  test("does not surface transport-only child progress as activity", () => {
    const model = deriveCanonicalChildren([
      event("child.started", 1, {
        childId: "child-1",
        title: "calc_a",
        state: { role: "calc_a" },
      }),
      event("child.updated", 2, {
        childId: "child-1",
        status: "Task usage updated",
        state: { usage: { totalTokens: 42 } },
      }),
    ]);

    expect(model.cards[0]?.status).toBeNull();
    expect(model.fidelity.get("child-1")).toMatchObject({
      progress: null,
      recentActivity: [],
      usage: { totalTokens: 42 },
    });
  });
});
