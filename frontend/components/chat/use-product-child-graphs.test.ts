import { expect, test } from "bun:test";
import type { ThreadRelationship } from "@useagent/agent-client";
import {
  expandedProductGraphBindings,
  matchesProductGraphInvalidation,
  productGraphBindings,
} from "./use-product-child-graphs";

const relationship = (threadId: string, latestRunId: string): ThreadRelationship => ({
  threadId,
  parentThreadId: "root",
  familyThreadId: "root",
  kind: "delegated",
  title: threadId,
  sourceRunId: "root",
  sourceExecutionId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:01.000Z",
  status: "running",
  engine: "codex",
  model: "gpt-5.6-sol",
  latestRunId,
  latestActivityAt: "2026-09-01T00:00:01.000Z",
});

test("refreshes only the exact child run on durable execution graph invalidation", () => {
  const [binding] = expandedProductGraphBindings([relationship("child-a", "run-a")], new Set());
  if (!binding) throw new Error("expected binding");
  expect(matchesProductGraphInvalidation(binding, {
    type: "execution_graph", runId: "run-a", threadId: "child-a", graphCursor: 8,
  })).toBe(true);
  expect(matchesProductGraphInvalidation(binding, {
    type: "execution_graph", runId: "run-b", threadId: "child-a", graphCursor: 8,
  })).toBe(false);
  expect(matchesProductGraphInvalidation(binding, {
    type: "execution_graph", runId: "run-a", threadId: "other", graphCursor: 8,
  })).toBe(false);
});

test("requests only expanded product children through their exact latest run binding", () => {
  expect(expandedProductGraphBindings(
    [relationship("child-a", "run-a"), relationship("child-b", "run-b")],
    new Set(["product:child-b"]),
    new Map([["child-a", 3]]),
  )).toEqual([{
    threadId: "child-a",
    runId: "run-a",
    activity: "2026-09-01T00:00:01.000Z",
    invalidation: 3,
  }]);
});

test("a collapsed cached child is marked dirty and refetches when re-expanded", () => {
  const child = relationship("child-a", "run-a");
  const collapsed = new Set(["product:child-a"]);
  const [binding] = productGraphBindings([child]);
  if (!binding) throw new Error("expected binding");

  expect(expandedProductGraphBindings([child], collapsed)).toEqual([]);
  expect(matchesProductGraphInvalidation(binding, {
    type: "execution_graph", runId: "run-a", threadId: "child-a", graphCursor: 9,
  })).toBe(true);

  expect(expandedProductGraphBindings([child], new Set(), new Map([["child-a", 1]])))
    .toEqual([{ ...binding, invalidation: 1 }]);
});
