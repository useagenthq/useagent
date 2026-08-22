// Pure-logic tests for the thread-stream hook's testable seams (Codex findings 2 & 4).
// The React wiring (adjust-state-on-prop-change, the effect's connection lifecycle)
// is covered by thread-connection.test.ts + the browser proof; these lock the two
// pure decisions the hook is built on.

import { describe, expect, test } from "bun:test";
import { createThreadStore } from "./thread-store";
import type { ApiRun, RunStatus } from "./types";
import { seedThreadStore, shouldRetireOptimistic } from "./use-thread-stream";

function makeRun(id: string, status: RunStatus = "running", parent: string | null = null): ApiRun {
  return {
    id, org_id: "org-1", user_id: null, parent_run_id: parent,
    prompt: `p ${id}`, model: "m", engine: "opencode", status, summary: null,
    duration_ms: null, engine_session_id: null, memory_scope: "org",
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), steps: [],
  };
}

describe("seedThreadStore (store lifetime keyed by rootRunId)", () => {
  test("seeds from initialThread only when it belongs to this root", () => {
    const s = seedThreadStore("A", [makeRun("A"), makeRun("B", "queued", "A")]);
    expect(s.getSnapshot().runs.map((r) => r.id)).toEqual(["A", "B"]);
  });

  test("does NOT seed a stale SSR payload from a different thread (finding 2)", () => {
    // Navigating A -> B without a remount: the OLD initialThread (thread A) must not
    // bleed into B's fresh store; it stays empty until B's SSE snapshot hydrates it.
    const s = seedThreadStore("B", [makeRun("A"), makeRun("A2", "queued", "A")]);
    expect(s.getSnapshot().runs.length).toBe(0);
  });

  test("empty initial thread yields an empty store", () => {
    expect(seedThreadStore("A", []).getSnapshot().runs.length).toBe(0);
  });
});

describe("shouldRetireOptimistic (keep an accepted reply until its durable run is observed)", () => {
  const snapWith = (...ids: string[]) => {
    const store = createThreadStore();
    for (const id of ids) store.upsertRun(makeRun(id));
    return store.getSnapshot();
  };

  test("null/absent run id never retires the optimistic bubble", () => {
    expect(shouldRetireOptimistic(null, snapWith("A"))).toBe(false);
    expect(shouldRetireOptimistic(undefined, snapWith("A"))).toBe(false);
  });

  test("a run id NOT yet in the store keeps the optimistic bubble (POST ok, SSE/fetch down)", () => {
    expect(shouldRetireOptimistic("B", snapWith("A"))).toBe(false);
  });

  test("retires only once the matching durable run is present (matched by id, not prompt)", () => {
    expect(shouldRetireOptimistic("B", snapWith("A", "B"))).toBe(true);
  });
});
