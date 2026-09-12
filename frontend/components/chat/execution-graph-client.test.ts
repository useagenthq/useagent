import { beforeEach, describe, expect, test } from "bun:test";
import type { StoredCanonicalEvent } from "./canonical-timeline";
import {
  executionHistoryKey,
  fetchExecutionGraph,
  fetchExecutionTranscript,
  fetchExecutionTranscriptById,
  mergeExecutionTranscript,
  resetExecutionGraphCache,
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
  beforeEach(() => resetExecutionGraphCache());

  test("resolves only a durable native-child execution id", () => {
    expect(
      resolveExecutionId(
        {
          executions: [
            { id: "root", mode: "root", provider: "opencode", native_session_id: "child" },
            {
              id: "child-execution",
              mode: "native_child",
              provider: "opencode",
              native_session_id: "child",
            },
          ],
        },
        "child",
      ),
    ).toBe("child-execution");
    expect(resolveExecutionId({ executions: [] }, "child")).toBeNull();
  });

  test("merges lazy history with live revisions without duplicate events", () => {
    expect(
      mergeExecutionTranscript(
        [event("a", 1), event("b", 2)],
        [event("a", 3, 1), event("c", 4)],
      ).map((item) => [item.eventId, item.deliverySeq, item.revision]),
    ).toEqual([
      ["b", 2, 0],
      ["a", 3, 1],
      ["c", 4, 0],
    ]);
  });

  test("keys cached history by both run and card identity", () => {
    expect(executionHistoryKey("run-a", "child")).not.toBe(executionHistoryKey("run-b", "child"));
  });

  test("loads the exact execution transcript without resolving a colliding native id", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      return Response.json({ events: [event("exact", 1)], has_more: false, next_cursor: 1 });
    }) as typeof fetch;
    try {
      expect(
        await fetchExecutionTranscriptById(
          "run-b",
          "execution-b",
          new AbortController().signal,
        ),
      ).toHaveLength(1);
      expect(calls).toEqual([
        "/api/runs/run-b/executions/execution-b/events?limit=200&cursor=0",
      ]);
      expect(calls.some((url) => url.includes("/executions?"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("paginates the graph and past 200 transcript events", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    const pageOne = Array.from({ length: 200 }, (_, index) =>
      event(`event-${index + 1}`, index + 1),
    );
    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/executions?")) {
        if (!url.includes("cursor=graph-1")) {
          return Response.json({
            executions: [],
            has_more: true,
            next_cursor: "graph-1",
          });
        }
        return Response.json({
          executions: [
            {
              id: "execution-child",
              mode: "native_child",
              provider: "opencode",
              native_session_id: "child",
            },
          ],
          has_more: false,
          next_cursor: "graph-2",
        });
      }
      if (url.endsWith("cursor=0")) {
        return Response.json({ events: pageOne, has_more: true, next_cursor: 200 });
      }
      return Response.json({
        events: [event("event-201", 201)],
        has_more: false,
        next_cursor: 201,
      });
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
      expect(calls.filter((url) => url.includes("/executions?"))).toHaveLength(2);
      expect(calls.at(-1)).toContain("cursor=200");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("decodes and deterministically merges paginated executions and delegation edges", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      const second = url.includes("cursor=page-2");
      return Response.json({
        graph_cursor: second ? 2 : 1,
        executions: [
          {
            id: second ? "execution-b" : "execution-a",
            mode: "native_child",
            provider: "codex",
            native_session_id: second ? "b" : "a",
            native_parent_session_id: second ? "a" : "root",
            status: second ? "completed" : "running",
            started_at: "2026-09-01T10:00:00.000Z",
            settled_at: second ? "2026-09-01T10:00:02.000Z" : null,
            created_at: second
              ? "2026-09-01T10:00:01.000Z"
              : "2026-09-01T10:00:00.000Z",
          },
        ],
        delegation_edges: [{
          id: second ? "edge-b" : "edge-a",
          parent_execution_id: second ? "execution-a" : "root-execution",
          child_execution_id: second ? "execution-b" : "execution-a",
          native_target_session_id: second ? "b" : "a",
          observed_delivery_seq: second ? 2 : 1,
        }],
        has_more: !second,
        next_cursor: second ? "page-3" : "page-2",
      });
    }) as typeof fetch;

    try {
      const graph = await fetchExecutionGraph("run-tree", new AbortController().signal);
      expect(graph?.executions.map((row) => row.id)).toEqual(["execution-a", "execution-b"]);
      expect(graph?.delegationEdges?.map((edge) => edge.id)).toEqual(["edge-a", "edge-b"]);
      expect(graph?.executions[1]?.native_parent_session_id).toBe("a");
      expect(graph?.graphCursor).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("authoritative refresh replaces a cached running execution with its completed revision", async () => {
    const originalFetch = globalThis.fetch;
    let request = 0;
    globalThis.fetch = (async () => {
      request += 1;
      return Response.json({
        graph_cursor: request,
        executions: [{
          id: "execution-child",
          mode: "native_child",
          provider: "codex",
          native_session_id: "child",
          status: request === 1 ? "running" : "completed",
          settled_at: request === 1 ? null : "2026-09-01T10:00:02.000Z",
          created_at: "2026-09-01T10:00:00.000Z",
        }],
        delegation_edges: [],
        has_more: false,
        next_cursor: "same-creation-cursor",
      });
    }) as typeof fetch;

    try {
      const signal = new AbortController().signal;
      expect((await fetchExecutionGraph("run-refresh", signal))?.executions[0]?.status).toBe("running");
      const refreshed = await fetchExecutionGraph("run-refresh", signal);
      expect(refreshed?.executions).toHaveLength(1);
      expect(refreshed?.executions[0]?.status).toBe("completed");
      expect(refreshed?.graphCursor).toBe(2);
      expect(request).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reopens known children without another graph request", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/executions?")) {
        return Response.json({
          executions: [
            {
              id: "execution-child",
              mode: "native_child",
              provider: "codex",
              native_session_id: "child",
            },
          ],
          has_more: false,
          next_cursor: "graph-1",
        });
      }
      return Response.json({ events: [event("done", 1)], has_more: false, next_cursor: 1 });
    }) as typeof fetch;

    try {
      const signal = new AbortController().signal;
      await fetchExecutionTranscript("run", "child", signal);
      await fetchExecutionTranscript("run", "child", signal);
      expect(calls.filter((url) => url.includes("/executions?"))).toHaveLength(1);
      expect(calls.filter((url) => url.includes("/events?"))).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("deduplicates an in-flight graph load for the same root", async () => {
    const originalFetch = globalThis.fetch;
    let releaseGraph: (() => void) | undefined;
    const graphReady = new Promise<void>((resolve) => {
      releaseGraph = resolve;
    });
    let graphCalls = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/executions?")) {
        graphCalls += 1;
        await graphReady;
        return Response.json({
          executions: [
            { id: "execution-a", mode: "native_child", provider: "codex", native_session_id: "a" },
            { id: "execution-b", mode: "native_child", provider: "codex", native_session_id: "b" },
          ],
          has_more: false,
          next_cursor: "graph-2",
        });
      }
      return Response.json({
        events: [event(url.includes("execution-a") ? "a" : "b", 1)],
        has_more: false,
        next_cursor: 1,
      });
    }) as typeof fetch;

    try {
      const signal = new AbortController().signal;
      const first = fetchExecutionTranscript("run", "a", signal);
      const second = fetchExecutionTranscript("run", "b", signal);
      await Promise.resolve();
      expect(graphCalls).toBe(1);
      releaseGraph?.();
      const [a, b] = await Promise.all([first, second]);
      expect(a?.[0]?.eventId).toBe("a");
      expect(b?.[0]?.eventId).toBe("b");
      expect(graphCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refreshes from the cached cursor when a live child misses the initial page", async () => {
    const originalFetch = globalThis.fetch;
    const graphUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/executions?")) {
        graphUrls.push(url);
        if (url.includes("cursor=graph-1")) {
          return Response.json({
            executions: [
              {
                id: "execution-b",
                mode: "native_child",
                provider: "codex",
                native_session_id: "b",
              },
            ],
            has_more: false,
            next_cursor: "graph-2",
          });
        }
        return Response.json({
          executions: [
            {
              id: "execution-a",
              mode: "native_child",
              provider: "codex",
              native_session_id: "a",
            },
          ],
          has_more: false,
          next_cursor: "graph-1",
        });
      }
      return Response.json({ events: [event("b", 1)], has_more: false, next_cursor: 1 });
    }) as typeof fetch;

    try {
      const signal = new AbortController().signal;
      expect(await fetchExecutionTranscript("run", "b", signal)).toHaveLength(1);
      expect(graphUrls).toHaveLength(2);
      expect(graphUrls[1]).toContain("cursor=graph-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rechecks an initially empty graph once so the first live child is discoverable", async () => {
    const originalFetch = globalThis.fetch;
    let graphCalls = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/executions?")) {
        graphCalls += 1;
        return graphCalls === 1
          ? Response.json({ executions: [], has_more: false, next_cursor: null })
          : Response.json({
              executions: [
                {
                  id: "execution-first-child",
                  mode: "native_child",
                  provider: "codex",
                  native_session_id: "first-child",
                },
              ],
              has_more: false,
              next_cursor: "graph-1",
            });
      }
      return Response.json({ events: [event("first-child", 1)], has_more: false, next_cursor: 1 });
    }) as typeof fetch;

    try {
      const result = await fetchExecutionTranscript(
        "run-empty",
        "first-child",
        new AbortController().signal,
      );
      expect(result).toHaveLength(1);
      expect(graphCalls).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps abort and 404 fallback semantics", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    try {
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        fetchExecutionTranscript("aborted", "child", aborted.signal),
      ).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(calls).toBe(0);
      expect(
        await fetchExecutionTranscript("missing", "child", new AbortController().signal),
      ).toBeNull();
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("passes the caller abort signal through transcript requests and fails open on 404", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let transcriptSignal: AbortSignal | null = null;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/executions?")) {
        return Response.json({
          executions: [
            {
              id: "execution-child",
              mode: "native_child",
              provider: "codex",
              native_session_id: "child",
            },
          ],
          has_more: false,
          next_cursor: "graph-1",
        });
      }
      transcriptSignal = init?.signal as AbortSignal;
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    try {
      expect(await fetchExecutionTranscript("run", "child", controller.signal)).toBeNull();
      expect(transcriptSignal).toBe(controller.signal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
