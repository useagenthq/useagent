import { expect, test } from "bun:test";
import { loadThreadRelationshipHint } from "./thread-relationship-hint";

const relationship = (parentThreadId: string | null) => ({
  relationship: {
    thread_id: "thread",
    parent_thread_id: parentThreadId,
    family_thread_id: "root",
    kind: parentThreadId ? "delegated" : "root",
    title: "Thread",
    source_run_id: "run",
    source_execution_id: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    status: "completed",
    engine: "codex",
    model: "gpt-5.6-sol",
    latest_run_id: "run",
    latest_activity_at: "2026-09-01T00:00:00.000Z",
  },
});

test("classifies root and child relationship truth before hydration", async () => {
  expect(await loadThreadRelationshipHint("thread", async () =>
    Response.json(relationship(null))
  )).toBe("root");
  expect(await loadThreadRelationshipHint("thread", async () =>
    Response.json(relationship("root"))
  )).toBe("child");
});

test("treats 404 as rollback/legacy root but transient failures as ambiguous", async () => {
  expect(await loadThreadRelationshipHint("thread", async () =>
    new Response(null, { status: 404 })
  )).toBe("legacy_or_off");
  expect(await loadThreadRelationshipHint("thread", async () =>
    new Response(null, { status: 503 })
  )).toBe("ambiguous");
  expect(await loadThreadRelationshipHint("thread", async () => {
    throw new Error("network");
  })).toBe("ambiguous");
});
