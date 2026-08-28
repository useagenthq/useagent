import { describe, expect, test } from "bun:test";
import {
  createExecutionProjector,
  expandedSyntheticEvents,
  fixtureEvidenceMatrix,
  normalizeAllFixtures,
  projectExecutions,
  replayThroughCanonicalStore,
  simulateFanOutAccounting,
  SYNTHETIC_FIXTURE_NOTICE,
} from "./child-execution-evaluator";

describe("synthetic child-execution conformance evaluator", () => {
  test("labels its evidence boundary honestly", () => {
    expect(SYNTHETIC_FIXTURE_NOTICE).toContain("Synthetic");
    expect(SYNTHETIC_FIXTURE_NOTICE).toContain("not adapter parsing or live provider fidelity");
    expect(fixtureEvidenceMatrix().every((entry) => (
      entry.evidence === "synthetic-fixture-only" && entry.productCapabilityClaimed === false
    ))).toBe(true);
  });

  test("normalizes synthetic lifecycle shapes and degrades fixtures without lifecycle events", () => {
    const events = normalizeAllFixtures();
    const projection = projectExecutions(events);
    expect(projection.childIds).toEqual([
      "codex-child",
      "claude-child",
      "codex-acp-child",
      "opencode-child",
      "pi-child",
    ]);
    for (const childId of projection.childIds) {
      expect(projection.eventsByExecution.get(childId)?.map((event) => event.kind)).toEqual([
        "tool.started",
        "tool.completed",
        "message.delta",
        "message.completed",
      ]);
    }
    expect(projection.delegationEdges).toEqual([
      { parentId: "codex-parent", childId: "codex-child" },
      { parentId: "claude-parent", childId: "claude-child" },
      { parentId: "codex-acp-parent", childId: "codex-acp-child" },
      { parentId: "opencode-parent", childId: "opencode-child" },
      { parentId: "pi-parent", childId: "pi-child" },
    ]);
    for (const unsupported of ["claude-acp-child", "acp-child", "dsh-child"]) {
      expect(projection.childIds).not.toContain(unsupported);
      expect(projection.eventsByExecution.has(unsupported)).toBe(false);
    }
  });

  test("wait remains a parent control tool and never creates a child", () => {
    const events = normalizeAllFixtures();
    const projection = projectExecutions(events);
    expect(projection.childIds).toHaveLength(5);
    expect(events.filter((event) => event.kind === "tool.started" && event.name === "wait_for_children"))
      .toHaveLength(8);
    expect(projection.childIds.some((id) => id.includes("wait"))).toBe(false);
  });

  test("replay is ordered and idempotent under duplicate and reversed delivery", () => {
    const events = normalizeAllFixtures();
    const replay = [...events].reverse();
    const store = replayThroughCanonicalStore([...replay, ...replay]);
    const snapshot = store.getSnapshot();
    expect(snapshot.events).toHaveLength(events.length);
    expect(snapshot.events.map((event) => event.deliverySeq)).toEqual(
      events.map((event) => event.deliverySeq).toSorted((a, b) => a - b),
    );
  });

  test("the pure execution projector converges under reversed duplicate lifecycle delivery", () => {
    const events = normalizeAllFixtures();
    const ordered = projectExecutions(events);
    const projector = createExecutionProjector();
    for (const event of [...events].reverse().flatMap((event) => [event, event])) {
      projector.ingest(event);
    }
    const replayed = projector.snapshot();
    expect(replayed.childIds.toSorted()).toEqual(ordered.childIds.toSorted());
    expect(replayed.delegationEdges.toSorted((a, b) => a.childId.localeCompare(b.childId))).toEqual(
      ordered.delegationEdges.toSorted((a, b) => a.childId.localeCompare(b.childId)),
    );
    for (const executionId of ordered.executionIds) {
      expect(replayed.eventsByExecution.get(executionId)?.map((event) => event.eventId)).toEqual(
        ordered.eventsByExecution.get(executionId)?.map((event) => event.eventId),
      );
    }
  });

  test("20 logical children obey a hard concurrency limit of 8", () => {
    expect(simulateFanOutAccounting(20, 8)).toEqual({
      maxRunning: 8,
      completed: Array.from({ length: 20 }, (_, index) => `child-${index + 1}`),
      queued: 0,
      running: 0,
    });
  });

  test("the 10k-event stress fixture projects exactly 100 stable child identities", () => {
    const projection = projectExecutions(expandedSyntheticEvents(10_000));
    expect(projection.childIds).toHaveLength(100);
    expect(new Set(projection.delegationEdges.map((edge) => edge.childId)).size).toBe(100);
  });
});
