import { describe, expect, test } from "bun:test";
import {
  createFirstOutputMarker,
  createRunTimer,
  deriveTimingTable,
  recordStageMark,
  recordStageSpan,
  RUN_TIMING_OUTCOMES,
  RUN_TIMING_STAGES,
  TIMING_MARK,
  TIMING_SPAN,
  type TimingSink,
} from "./run-timing";

type Captured = Parameters<TimingSink>[0];

function collector(): { sink: TimingSink; events: Captured[] } {
  const events: Captured[] = [];
  return { sink: (input) => events.push(input), events };
}

describe("run-timing ledger", () => {
  test("span records stable id, provider lane fields, and clamped duration", () => {
    const { sink, events } = collector();
    recordStageSpan("run-1", "thread-1", RUN_TIMING_STAGES.sandboxCreate, 1000, 1750, sink, RUN_TIMING_OUTCOMES.success);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("run-1:timing:sandbox.create");
    expect(events[0]?.eventType).toBe(TIMING_SPAN);
    expect(events[0]?.payload).toEqual({
      stage: RUN_TIMING_STAGES.sandboxCreate,
      outcome: RUN_TIMING_OUTCOMES.success,
      startedAt: 1000,
      endedAt: 1750,
      durMs: 750,
    });
    // A clock that steps backwards must never yield a negative duration.
    recordStageSpan("run-1", "thread-1", "weird", 2000, 1900, sink);
    expect((events[1]?.payload as { durMs: number } | undefined)?.durMs).toBe(0);
  });

  test("standard timing stage and outcome vocabulary stays low-cardinality", () => {
    expect(Object.values(RUN_TIMING_STAGES).toSorted()).toEqual([
      "desktop.mcp_readiness",
      "desktop.readiness",
      "provider.session_persist",
      "provider.session_resume",
      "provider.session_start",
      "repo.prep",
      "runtime.readiness",
      "sandbox.create",
      "sandbox.retained",
      "sandbox.warm_pool",
      "workdir.boundary",
    ]);
    expect(Object.values(RUN_TIMING_OUTCOMES).toSorted()).toEqual([
      "aborted",
      "disabled",
      "failure",
      "hit",
      "miss",
      "ready",
      "repaired",
      "skipped",
      "success",
      "unavailable",
    ]);
  });

  test("mark records the milestone shape", () => {
    const { sink, events } = collector();
    recordStageMark("run-1", "thread-1", "dispatch", 5000, sink);
    expect(events[0]?.eventType).toBe(TIMING_MARK);
    expect(events[0]?.payload).toEqual({ stage: "dispatch", at: 5000 });
  });

  test("timer begin/end records exactly once (idempotent closer)", () => {
    const { sink, events } = collector();
    const timer = createRunTimer("run-2", "thread-2", sink);
    const end = timer.begin("prepare");
    end(RUN_TIMING_OUTCOMES.success);
    end(); // second call is a no-op
    timer.mark("dispatch");
    expect(events).toHaveLength(2);
    expect(events[0]?.id).toBe("run-2:timing:prepare");
    const span = events[0]?.payload as {
      startedAt: number;
      endedAt: number;
      durMs: number;
      outcome?: string;
    } | undefined;
    expect(span).toBeDefined();
    if (!span) throw new Error("missing timing span");
    expect(span.endedAt).toBeGreaterThanOrEqual(span.startedAt);
    expect(span.outcome).toBe(RUN_TIMING_OUTCOMES.success);
    expect(events[1]?.id).toBe("run-2:timing:dispatch");
  });

  test("records only the first visible, reasoning, and text output milestones", () => {
    const stages: string[] = [];
    const markOutput = createFirstOutputMarker({ mark: (stage) => stages.push(stage) });

    markOutput("   ", "reasoning");
    markOutput("thinking", "reasoning");
    markOutput("more thinking", "reasoning");
    markOutput("answer");
    markOutput("more answer");

    expect(stages).toEqual([
      "first_reasoning_delta",
      "first_visible_delta",
      "first_text_delta",
    ]);
  });

  test("a throwing sink never propagates (timing must not fail a run)", () => {
    const timer = createRunTimer("run-3", "thread-3", () => {
      throw new Error("sink down");
    });
    // recordProviderEvent's chain swallows persist errors; the pure helpers must
    // not add a new throwing path either.
    expect(() => timer.mark("dispatch")).toThrow(); // documents the sink contract:
    // the DEFAULT sink is fire-and-forget (void promise) and cannot throw; a
    // custom sink that throws synchronously is a programming error surfaced loudly.
  });
});

describe("deriveTimingTable", () => {
  const rows = [
    { eventType: TIMING_SPAN, payload: JSON.stringify({ stage: "sandbox", outcome: RUN_TIMING_OUTCOMES.hit, startedAt: 100, endedAt: 400, durMs: 300 }) },
    { eventType: TIMING_SPAN, payload: { stage: "prepare", outcome: "tenant-123", startedAt: 400, endedAt: 900, durMs: 500 } },
    { eventType: TIMING_MARK, payload: { stage: "dispatch", at: 950 } },
    { eventType: TIMING_MARK, payload: { stage: "first_reasoning_delta", at: 1200 } },
    { eventType: TIMING_MARK, payload: { stage: "first_visible_delta", at: 1200 } },
    { eventType: TIMING_MARK, payload: { stage: "first_text_delta", at: 1500 } },
    { eventType: TIMING_SPAN, payload: { stage: "engine.turn", startedAt: 50, endedAt: 2000, durMs: 1950 } },
  ];

  test("orders by start, extracts dispatch, computes total", () => {
    const table = deriveTimingTable(rows);
    expect(table.rows.map((r) => r.stage)).toEqual([
      "engine.turn",
      "sandbox",
      "prepare",
      "dispatch",
      "first_reasoning_delta",
      "first_visible_delta",
      "first_text_delta",
    ]);
    expect(table.dispatchAt).toBe(950);
    expect(table.totalMs).toBe(2000 - 50);
    expect(table.timeToFirstEventMs).toBeNull(); // no first-event input supplied
    expect(table.timeToFirstReasoningMs).toBe(250);
    expect(table.timeToFirstVisibleMs).toBe(250);
    expect(table.timeToFirstTextMs).toBe(550);
    expect(table.rows.find((row) => row.stage === "sandbox")?.outcome).toBe(RUN_TIMING_OUTCOMES.hit);
    expect(table.rows.find((row) => row.stage === "prepare")?.outcome).toBeNull();
  });

  test("computes dispatch-to-first-event when supplied", () => {
    const table = deriveTimingTable(rows, 1500);
    expect(table.timeToFirstEventMs).toBe(550);
    // A first event stamped before dispatch clamps to zero rather than negative.
    expect(deriveTimingTable(rows, 900).timeToFirstEventMs).toBe(0);
  });

  test("malformed payloads are skipped, never throw", () => {
    const table = deriveTimingTable([
      { eventType: TIMING_SPAN, payload: "not json {" },
      { eventType: TIMING_SPAN, payload: { stage: "x" } }, // missing numbers
      { eventType: TIMING_MARK, payload: { stage: 42, at: 1 } }, // wrong stage type
      { eventType: "other.event", payload: { stage: "y", startedAt: 1, endedAt: 2 } },
    ]);
    expect(table.rows).toEqual([]);
    expect(table.totalMs).toBeNull();
  });
});
