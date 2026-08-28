import { describe, expect, test } from "bun:test";
import {
  CANONICAL_SCHEMA_VERSION,
  type CanonicalEventBody,
} from "@useagent/agent-harness/canonical";
import {
  createExecutionSummaryProjector,
  type CanonicalThreadEvent,
} from "../src";

function event(
  deliverySeq: number,
  nativeSessionId: string,
  body: CanonicalEventBody,
  eventId = `event-${deliverySeq}`,
  revision = 0,
): CanonicalThreadEvent {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    eventId,
    seq: deliverySeq,
    runId: "run-1",
    threadId: "thread-1",
    ts: deliverySeq,
    identity: {
      provider: "test-provider",
      nativeSessionId,
      nativeEventId: eventId,
      nativeSeq: deliverySeq,
    },
    deliverySeq,
    revision,
    ...body,
  } as CanonicalThreadEvent;
}

describe("execution summary projector", () => {
  test("attaches early child-owned activity when lifecycle identity arrives", () => {
    const projector = createExecutionSummaryProjector({ threadId: "thread-1" });
    projector.ingest(event(1, "child-1", {
      kind: "tool.started",
      toolCallId: "tool-1",
      name: "read_file",
    }));
    projector.ingest(event(2, "child-1", {
      kind: "message.completed",
      messageId: "message-1",
      text: "Ready",
    }));
    projector.ingest(event(3, "child-1", {
      kind: "child.started",
      childId: "child-1",
      parentChildId: "parent-child",
      launchToolCallId: "launch-1",
      title: "Researcher",
      state: {
        status: "running",
        prompt: "Inspect",
        role: "researcher",
        model: "test/model",
        usage: { inputTokens: 3 },
        resumable: true,
      },
    }));

    expect(projector.snapshot().children).toEqual([{
      id: "child-1",
      parentId: "parent-child",
      aliases: ["child-1", "launch-1"],
      identity: {
        provider: "test-provider",
        nativeSessionId: "child-1",
        nativeParentSessionId: null,
      },
      runId: "run-1",
      startedSeq: 3,
      startedAt: 3,
      lastActivitySeq: 3,
      lastActivityAt: 3,
      title: "Researcher",
      prompt: "Inspect",
      role: "researcher",
      model: "test/model",
      status: "running",
      summary: null,
      lastToolName: "read_file",
      lastToolStatus: "running",
      lastMessagePreview: "Ready",
      result: null,
      usage: { inputTokens: 3 },
      resumable: true,
    }]);
  });

  test("newer revisions replace one event while stale revisions remain no-ops", () => {
    const projector = createExecutionSummaryProjector();
    projector.ingest(event(1, "parent", { kind: "child.started", childId: "child-1" }));
    projector.ingest(event(2, "parent", {
      kind: "child.updated",
      childId: "child-1",
      status: "running",
      state: { summary: "old" },
    }, "update"));
    expect(projector.ingest(event(2, "parent", {
      kind: "child.updated",
      childId: "child-1",
      status: "running",
      state: { summary: "new" },
    }, "update", 1))).toBe(true);
    expect(projector.ingest(event(3, "parent", {
      kind: "child.updated",
      childId: "child-1",
      status: "running",
      state: { summary: "stale" },
    }, "update", 0))).toBe(false);
    expect(projector.snapshot().children[0]?.summary).toBe("new");
  });

  test("retains explicit child and parent native identity", () => {
    const projector = createExecutionSummaryProjector();
    projector.ingest({
      ...event(1, "child-1", { kind: "child.started", childId: "child-1" }),
      identity: {
        provider: "test-provider",
        nativeSessionId: "child-1",
        nativeParentSessionId: "parent-1",
      },
    });
    expect(projector.snapshot().children[0]?.identity).toEqual({
      provider: "test-provider",
      nativeSessionId: "child-1",
      nativeParentSessionId: "parent-1",
    });
    expect(projector.snapshot().children[0]?.parentId).toBe("parent-1");

    const missingParent = createExecutionSummaryProjector();
    missingParent.ingest(event(1, "child-2", {
      kind: "child.started",
      childId: "child-2",
    }));
    expect(missingParent.snapshot().children[0]?.parentId).toBe("run-1");
    expect(missingParent.snapshot().delegationEdges).toEqual([
      { parentId: "run-1", childId: "child-2" },
    ]);
  });

  test("compaction drops orphan bookkeeping and rejects replay through the durable cursor", () => {
    const projector = createExecutionSummaryProjector();
    const orphan = event(1, "never-announced", {
      kind: "tool.started",
      toolCallId: "tool-1",
      name: "read_file",
    });
    projector.ingest(orphan);
    expect(projector.retention()).toMatchObject({
      threadId: "thread-1",
      acceptedEvents: 1,
      children: 0,
      pendingChildren: 1,
      pendingContributions: 3,
    });
    expect(projector.compactThrough(1)).toMatchObject({
      acceptedEvents: 0,
      pendingChildren: 0,
      pendingContributions: 0,
      compactedThrough: 1,
    });
    expect(projector.ingest(orphan)).toBe(false);
  });

  test("rejects cross-thread ingestion instead of merging identities", () => {
    const projector = createExecutionSummaryProjector();
    const started = event(1, "parent", { kind: "child.started", childId: "child-1" });
    projector.ingest(started);
    expect(() => projector.ingest({ ...started, threadId: "thread-2", eventId: "other" }))
      .toThrow("bound to thread thread-1");
  });
});
