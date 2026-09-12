import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ThreadRelationship } from "@useagent/agent-client";
import {
  descendantThreadRelationships,
  fetchThreadFamily,
  fetchThreadRelationshipIndex,
  THREAD_RELATIONSHIP_PAGE_SIZE,
  THREAD_RELATIONSHIP_SNAPSHOT_LIMIT,
} from "./thread-relationships-data";

const relationship = (threadId: string, parentThreadId: string | null): ThreadRelationship => ({
  threadId,
  parentThreadId,
  familyThreadId: "root",
  kind: parentThreadId ? "delegated" : "root",
  title: threadId,
  sourceRunId: "root",
  sourceExecutionId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  status: "completed",
  engine: "codex",
  model: "gpt-5.6-sol",
  latestRunId: threadId,
  latestActivityAt: "2026-09-01T00:00:00.000Z",
});

test("selects only the current product thread's descendants", () => {
  const family = [
    relationship("a", "root"),
    relationship("a1", "a"),
    relationship("b", "root"),
  ];
  expect(descendantThreadRelationships(family, "root").map((item) => item.threadId)).toEqual(["a", "a1", "b"]);
  expect(descendantThreadRelationships(family, "a").map((item) => item.threadId)).toEqual(["a1"]);
  expect(descendantThreadRelationships(family, "b")).toEqual([]);
});

const originalFetch = globalThis.fetch;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
let requests: Array<() => void> = [];
let requestCount = 0;

beforeEach(() => {
  requests = [];
  requestCount = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  globalThis.fetch = (async () => {
    requestCount += 1;
    await new Promise<void>((resolve) => requests.push(resolve));
    const item = relationship(`child-${requestCount}`, "root");
    return Response.json({
      relationships: [{
        thread_id: item.threadId,
        parent_thread_id: item.parentThreadId,
        family_thread_id: item.familyThreadId,
        kind: item.kind,
        title: item.title,
        source_run_id: item.sourceRunId,
        source_execution_id: item.sourceExecutionId,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        status: item.status,
        engine: item.engine,
        model: item.model,
        latest_run_id: item.latestRunId,
        latest_activity_at: item.latestActivityAt,
      }],
      next_cursor: null,
      has_more: false,
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
});

test("coalesces a fan-out invalidation burst and resolves the latest relationship snapshot", async () => {
  const initial = fetchThreadRelationshipIndex();
  const peers = Array.from({ length: 50 }, () =>
    fetchThreadRelationshipIndex({ revalidate: true }),
  );
  expect(requestCount).toBe(1);
  requests[0]?.();
  while (requestCount < 2) await Promise.resolve();
  expect(requestCount).toBe(2);
  requests[1]?.();
  expect((await initial).relationships[0]?.threadId).toBe("child-2");
  expect((await Promise.all(peers)).every((page) => page.relationships[0]?.threadId === "child-2")).toBe(true);
  expect(requestCount).toBe(2);
});

test("paginates a family snapshot and preserves explicit truncation metadata", async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    const second = url.includes("cursor=next");
    const item = relationship(second ? "child-2" : "child-1", "root");
    return Response.json({
      children: [{
        thread_id: item.threadId,
        parent_thread_id: item.parentThreadId,
        family_thread_id: item.familyThreadId,
        kind: item.kind,
        title: item.title,
        source_run_id: item.sourceRunId,
        source_execution_id: item.sourceExecutionId,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        status: item.status,
        engine: item.engine,
        model: item.model,
        latest_run_id: item.latestRunId,
        latest_activity_at: item.latestActivityAt,
      }],
      next_cursor: second ? null : "next",
      has_more: !second,
    });
  }) as typeof fetch;

  const page = await fetchThreadFamily("root");
  expect(page.children.map((item) => item.threadId)).toEqual(["child-1", "child-2"]);
  expect(page.hasMore).toBe(false);
  expect(page.nextCursor).toBeNull();
  expect(THREAD_RELATIONSHIP_PAGE_SIZE).toBe(100);
});

test("paginates the organization relationship index instead of silently dropping later pages", async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    const second = url.includes("cursor=index-next");
    const item = relationship(second ? "index-2" : "index-1", "root");
    return Response.json({
      relationships: [{
        thread_id: item.threadId,
        parent_thread_id: item.parentThreadId,
        family_thread_id: item.familyThreadId,
        kind: item.kind,
        title: item.title,
        source_run_id: item.sourceRunId,
        source_execution_id: item.sourceExecutionId,
        created_at: item.createdAt,
        updated_at: item.updatedAt,
        status: item.status,
        engine: item.engine,
        model: item.model,
        latest_run_id: item.latestRunId,
        latest_activity_at: item.latestActivityAt,
      }],
      next_cursor: second ? null : "index-next",
      has_more: !second,
    });
  }) as typeof fetch;

  const snapshot = await fetchThreadRelationshipIndex();
  expect(snapshot.relationships.map((item) => item.threadId)).toEqual(["index-1", "index-2"]);
  expect(snapshot.truncated).toBe(false);
  expect(snapshot.nextCursor).toBeNull();
});

test("marks an index snapshot truncated at the documented collection bound", async () => {
  let pageNumber = 0;
  globalThis.fetch = (async () => {
    pageNumber += 1;
    return Response.json({
      relationships: Array.from({ length: THREAD_RELATIONSHIP_PAGE_SIZE }, (_, index) => {
        const item = relationship(`bounded-${pageNumber}-${index}`, "root");
        return {
          thread_id: item.threadId,
          parent_thread_id: item.parentThreadId,
          family_thread_id: item.familyThreadId,
          kind: item.kind,
          title: item.title,
          source_run_id: item.sourceRunId,
          source_execution_id: item.sourceExecutionId,
          created_at: item.createdAt,
          updated_at: item.updatedAt,
          status: item.status,
          engine: item.engine,
          model: item.model,
          latest_run_id: item.latestRunId,
          latest_activity_at: item.latestActivityAt,
        };
      }),
      next_cursor: `bounded-${pageNumber}`,
      has_more: true,
    });
  }) as typeof fetch;

  const snapshot = await fetchThreadRelationshipIndex();
  expect(snapshot.relationships).toHaveLength(THREAD_RELATIONSHIP_SNAPSHOT_LIMIT);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.nextCursor).toBe(`bounded-${pageNumber}`);
  expect(pageNumber).toBe(THREAD_RELATIONSHIP_SNAPSHOT_LIMIT / THREAD_RELATIONSHIP_PAGE_SIZE);
});

test("dedupes repeated relationship roots without consuming the unique-row bound", async () => {
  let page = 0;
  globalThis.fetch = (async () => {
    page += 1;
    const root = relationship("root", null);
    const child = relationship(`unique-${page}`, "root");
    const wire = (item: ThreadRelationship) => ({
      thread_id: item.threadId,
      parent_thread_id: item.parentThreadId,
      family_thread_id: item.familyThreadId,
      kind: item.kind,
      title: item.threadId === "root" ? `root-page-${page}` : item.title,
      source_run_id: item.sourceRunId,
      source_execution_id: item.sourceExecutionId,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
      status: item.status,
      engine: item.engine,
      model: item.model,
      latest_run_id: item.latestRunId,
      latest_activity_at: item.latestActivityAt,
    });
    return Response.json({
      relationships: [wire(root), wire(child)],
      next_cursor: page === 2 ? null : `dedupe-${page}`,
      has_more: page < 2,
    });
  }) as typeof fetch;

  const snapshot = await fetchThreadRelationshipIndex();
  expect(snapshot.relationships.map((item) => item.threadId)).toEqual([
    "root", "unique-1", "unique-2",
  ]);
  expect(snapshot.relationships[0]?.title).toBe("root-page-2");
  expect(snapshot.truncated).toBe(false);
});
