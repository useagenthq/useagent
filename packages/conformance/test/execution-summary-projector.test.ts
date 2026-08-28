import { describe, expect, test } from "bun:test";
import {
  createExecutionSummaryProjector,
  type CanonicalThreadEvent,
} from "@useagent/agent-client";
import {
  executionSummaryBytes,
  recomputeExecutionSummary,
} from "./execution-summary-projector";
import {
  executionSummaryEvents,
  revisedExecutionSummaryEvent,
} from "./execution-summary-fixtures";

function incrementalBytes(events: ReturnType<typeof executionSummaryEvents>): string {
  const projector = createExecutionSummaryProjector();
  for (const event of events) projector.ingest(event);
  return executionSummaryBytes(projector.snapshot());
}

describe("two-level execution summary projector", () => {
  for (const childCount of [1, 20, 100]) {
    test(`matches full-history recomputation for ${childCount} children`, () => {
      const events = executionSummaryEvents(Math.max(1_000, childCount * 12), childCount);
      expect(incrementalBytes(events)).toBe(executionSummaryBytes(recomputeExecutionSummary(events)));
    });
  }

  test("converges byte-for-byte under duplicates, reversal, and a newer revision", () => {
    const events = executionSummaryEvents(1_000, 20);
    const original = events.find((event) => event.kind === "child.updated")!;
    const revised = revisedExecutionSummaryEvent(original, 1);
    const adversarial = [revised, ...events, ...events].reverse();
    expect(incrementalBytes(adversarial)).toBe(
      executionSummaryBytes(recomputeExecutionSummary(adversarial)),
    );
  });

  test("ignores stale duplicates without invalidating the cached snapshot", () => {
    const events = executionSummaryEvents(1_000, 20);
    const projector = createExecutionSummaryProjector();
    for (const event of events) projector.ingest(event);
    const before = projector.snapshot();
    expect(projector.ingest(events[0]!)).toBe(false);
    expect(projector.snapshot()).toBe(before);
  });

  test("keeps the live snapshot bounded and transcript-free at 10k events", () => {
    const events = executionSummaryEvents(10_000, 100);
    const projector = createExecutionSummaryProjector();
    for (const event of events) projector.ingest(event);
    const snapshot = projector.snapshot();
    const encoded = executionSummaryBytes(snapshot);
    expect(snapshot.children).toHaveLength(100);
    expect(snapshot.delegationEdges).toHaveLength(100);
    expect(encoded).not.toContain("events");
    expect(Buffer.byteLength(encoded)).toBeLessThan(65_000);
  });

  test("projects the production-only identity, alias, and child-state fields", () => {
    const [source] = executionSummaryEvents(1, 1);
    expect(source?.kind).toBe("child.started");
    const started = {
      ...source!,
      parentChildId: "parent-child",
      launchToolCallId: "launch-call",
      state: {
        status: "running",
        prompt: "Inspect the data",
        role: "researcher",
        model: "test/model",
        usage: { inputTokens: 12 },
        resumable: true,
        summary: "Working",
        lastToolName: "read_file",
      },
    } as CanonicalThreadEvent;
    const projector = createExecutionSummaryProjector();
    projector.ingest(started);
    expect(projector.snapshot().children[0]).toMatchObject({
      id: "child-1",
      parentId: "parent-child",
      aliases: ["child-1", "launch-call"],
      identity: { provider: "benchmark", nativeSessionId: null, nativeParentSessionId: null },
      prompt: "Inspect the data",
      role: "researcher",
      model: "test/model",
      usage: { inputTokens: 12 },
      resumable: true,
    });
  });

  test("binds one projector to one thread", () => {
    const [event] = executionSummaryEvents(1, 1);
    const projector = createExecutionSummaryProjector();
    projector.ingest(event!);
    expect(() => projector.ingest({ ...event!, threadId: "other-thread" })).toThrow(
      "bound to thread summary-benchmark-thread",
    );
  });

  test("a revision that changes child identity removes the superseded child", () => {
    const [source] = executionSummaryEvents(1, 1);
    if (!source || source.kind !== "child.started") throw new Error("expected child.started fixture");
    const projector = createExecutionSummaryProjector();
    projector.ingest(source);
    const childActivity: CanonicalThreadEvent = {
      ...source,
      eventId: "child-1-tool",
      seq: 2,
      deliverySeq: 2,
      identity: { ...source.identity, nativeSessionId: "child-1" },
      kind: "tool.started",
      toolCallId: "tool-1",
      name: "read_file",
    };
    projector.ingest(childActivity);
    const revised: CanonicalThreadEvent = {
      ...source,
      revision: 1,
      childId: "child-2",
      title: "Corrected child",
    };
    projector.ingest(revised);
    expect(projector.snapshot().children.map((child) => child.id)).toEqual(["child-2"]);
    expect(projector.snapshot().delegationEdges.map((edge) => edge.childId)).toEqual(["child-2"]);
    expect(projector.retention()).toMatchObject({ pendingChildren: 1, pendingContributions: 3 });
    expect(executionSummaryBytes(projector.snapshot())).toBe(
      executionSummaryBytes(recomputeExecutionSummary([source, childActivity, revised])),
    );
  });

  test("compaction bounds retained bookkeeping without changing the snapshot", () => {
    const events = executionSummaryEvents(10_000, 100);
    const projector = createExecutionSummaryProjector();
    for (const event of events) projector.ingest(event);
    const before = executionSummaryBytes(projector.snapshot());
    expect(projector.retention().acceptedEvents).toBe(10_000);

    const retained = projector.compactThrough(10_000);
    expect(retained.acceptedEvents).toBe(0);
    expect(retained.pendingChildren).toBe(0);
    expect(retained.pendingContributions).toBe(0);
    expect(retained.slotContributions).toBeLessThanOrEqual(1_700);
    expect(executionSummaryBytes(projector.snapshot())).toBe(before);
    expect(projector.ingest(events[0]!)).toBe(false);
  });

  test("compaction removes activity for a child that was never announced", () => {
    const events = executionSummaryEvents(2, 1);
    const activity = { ...events[1]!, identity: { ...events[1]!.identity, nativeSessionId: "orphan" } };
    const projector = createExecutionSummaryProjector();
    projector.ingest(activity);
    expect(projector.retention()).toMatchObject({
      acceptedEvents: 1,
      children: 0,
      pendingChildren: 1,
      pendingContributions: 3,
    });
    expect(projector.compactThrough(activity.deliverySeq)).toMatchObject({
      acceptedEvents: 0,
      children: 0,
      pendingChildren: 0,
      pendingContributions: 0,
    });
  });
});
