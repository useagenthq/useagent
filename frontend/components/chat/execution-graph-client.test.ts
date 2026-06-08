import { describe, expect, test } from "bun:test";
import type { StoredCanonicalEvent } from "./canonical-timeline";
import {
  executionHistoryKey,
  fetchExecutionTranscript,
  mergeExecutionTranscript,
  resolveExecutionId,
} from "./execution-graph-client";

function event(eventId: string, deliverySeq: number, revision = 0): StoredCanonicalEvent {
  return {
    schemaVersion: 1,
    eventId,
    runId: "run",
    threadId: "thread",
    deliverySeq,
    revision,
    kind: "message.completed",
    seq: deliverySeq,
    identity: { provider: "opencode", nativeSessionId: "child" },
  };
}

describe("execution graph client", () => {
  test("resolves only a durable native-child execution id", () => {
    expect(resolveExecutionId({ executions: [
      { id: "root", mode: "root", provider: "opencode", native_session_id: "child" },
      { id: "child-execution", mode: "native_child", provider: "opencode", native_session_id: "child" },
    ] }, "child")).toBe("child-execution");
    expect(resolveExecutionId({ executions: [] }, "child")).toBeNull();
  });

  test("merges lazy history with live revisions without duplicate events", () => {
    expect(mergeExecutionTranscript(
      [event("a", 1), event("b", 2)],
      [event("a", 3, 1), event("c", 4)],
    ).map((item) => [item.eventId, item.deliverySeq, item.revision])).toEqual([
      ["b", 2, 0],
      ["a", 3, 1],
      ["c", 4, 0],
    ]);
  });

  test("keys cached history by both run and card identity", () => {
    expect(executionHistoryKey("run-a", "child")).not.toBe(
      executionHistoryKey("run-b", "child"),
    );
  });

  test("paginates past 200 events and publishes progressive history", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const pageOne = Array.from({ length: 200 }, (_, index) =>
      event(`event-${index + 1}`, index + 1));
    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/executions")) {
        return Response.json({
          executions: [{
            id: "execution-child",
            mode: "native_child",
            provider: "opencode",
            native_session_id: "child",
          }],
        });
      }
      if (url.endsWith("cursor=0")) {
        return Response.json({ events: pageOne, has_more: true, next_cursor: 200 });
      }
      return Response.json({ events: [event("event-201", 201)], has_more: false, next_cursor: 201 });
    }) as typeof fetch;
    const pageSizes: number[] = [];

    try {
      const result = await fetchExecutionTranscript(
        "run",
        "child",
        new AbortController().signal,
        (events) => pageSizes.push(events.length),
      );
      expect(result).toHaveLength(201);
      expect(pageSizes).toEqual([200, 201]);
      expect(calls.at(-1)).toContain("cursor=200");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
