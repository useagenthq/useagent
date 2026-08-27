import { describe, expect, test } from "bun:test";
import type { ApiRun } from "./types";
import {
  type ApiThreadOutlineTurn,
  chunkTurnIds,
  decodeExactTurnsResponse,
  decodeThreadOutline,
  decodeTurnsResponse,
  INITIAL_TAIL_TURNS,
  initialTurnIds,
  missingRequestedTurnIds,
  outlineStubTurn,
  sortRunsByThreadOrder,
  TURN_FETCH_CHUNK,
} from "./windowed-thread";

const outlineTurn = (
  n: number,
  over: Partial<ApiThreadOutlineTurn> = {},
): ApiThreadOutlineTurn => ({
  id: `run-${String(n).padStart(3, "0")}`,
  status: "completed",
  step_count: 4,
  has_summary: true,
  created_at: new Date(1_700_000_000_000 + n * 60_000).toISOString(),
  ...over,
});

const wireRun = (n: number): ApiRun => ({
  id: `run-${String(n).padStart(3, "0")}`,
  org_id: null,
  user_id: null,
  project_id: null,
  prompt: `prompt ${n}`,
  model: "m",
  engine: "opencode",
  status: "completed",
  summary: "done",
  duration_ms: 1,
  parent_run_id: null,
  child_session: false,
  thread_id: "run-000",
  engine_session_id: null,
  repo: null,
  repos: [],
  repo_specs: [],
  resolved_resources: [],
  memory_scope: "org",
  skill_id: null,
  skill_version: null,
  skill_content_hash: null,
  uploads: [],
  created_at: new Date(1_700_000_000_000 + n * 60_000).toISOString(),
  updated_at: new Date(1_700_000_000_000 + n * 60_000).toISOString(),
  steps: [],
});

describe("initialTurnIds", () => {
  test("a thread within the tail budget loads whole", () => {
    const outline = Array.from({ length: INITIAL_TAIL_TURNS + 1 }, (_, i) => outlineTurn(i));
    expect(initialTurnIds(outline)).toEqual(outline.map((t) => t.id));
  });

  test("a long thread loads the ROOT plus the last tail turns, no duplicates", () => {
    const outline = Array.from({ length: 100 }, (_, i) => outlineTurn(i));
    const ids = initialTurnIds(outline);
    expect(ids).toHaveLength(INITIAL_TAIL_TURNS + 1);
    expect(ids[0]).toBe("run-000"); // the root anchors the page identity
    expect(ids.at(-1)).toBe("run-099");
    expect(ids[1]).toBe(`run-${String(100 - INITIAL_TAIL_TURNS).padStart(3, "0")}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a running turn outside the tail and forty queued turns are all eager", () => {
    const outline = Array.from({ length: 101 }, (_, i) =>
      outlineTurn(i, {
        status: i === 12 ? "running" : i >= 61 ? "queued" : "completed",
      }),
    );
    const ids = initialTurnIds(outline);
    expect(ids).toHaveLength(42);
    expect(ids[0]).toBe("run-000");
    expect(ids).toContain("run-012");
    expect(ids.slice(-40)).toEqual(outline.slice(-40).map((turn) => turn.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("chunkTurnIds", () => {
  test("splits into backend-bounded chunks preserving order", () => {
    const ids = Array.from({ length: TURN_FETCH_CHUNK + 11 }, (_, i) => `id-${i}`);
    const chunks = chunkTurnIds(ids);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(TURN_FETCH_CHUNK);
    expect(chunks[1]).toHaveLength(11);
    expect(chunks.flat()).toEqual(ids);
  });

  test("a small list is one chunk; an empty list none", () => {
    expect(chunkTurnIds(["a"])).toEqual([["a"]]);
    expect(chunkTurnIds([])).toEqual([]);
  });
});

describe("decodeThreadOutline", () => {
  test("decodes valid turns and drops malformed entries", () => {
    const good = outlineTurn(1);
    const decoded = decodeThreadOutline({
      turns: [good, { id: 5 }, { ...outlineTurn(2), status: "nope" }, null],
    });
    expect(decoded).toEqual([good]);
  });

  test("a non-outline payload decodes to empty", () => {
    expect(decodeThreadOutline(null)).toEqual([]);
    expect(decodeThreadOutline({ thread: [] })).toEqual([]);
  });
});

describe("decodeTurnsResponse", () => {
  test("decodes full runs from { turns } and drops malformed entries", () => {
    const run = wireRun(3);
    expect(decodeTurnsResponse({ turns: [run, { id: "broken" }] })).toEqual([run]);
    expect(decodeTurnsResponse(undefined)).toEqual([]);
  });
});

describe("windowed response completeness", () => {
  test("initial SSR requires exactly every requested turn", () => {
    const a = wireRun(1);
    const b = wireRun(2);
    expect(decodeExactTurnsResponse({ turns: [b, a] }, [a.id, b.id])).toEqual([b, a]);
    expect(decodeExactTurnsResponse({ turns: [a] }, [a.id, b.id])).toBeNull();
    expect(decodeExactTurnsResponse({ turns: [a, { id: b.id }] }, [a.id, b.id])).toBeNull();
    expect(decodeExactTurnsResponse({ turns: [a, a] }, [a.id, b.id])).toBeNull();
    expect(decodeExactTurnsResponse({ turns: [a, wireRun(3)] }, [a.id, b.id])).toBeNull();
  });

  test("a partial or malformed island releases only missing ids for retry", () => {
    const a = wireRun(1);
    const decoded = decodeTurnsResponse({ turns: [a, { id: "run-002" }] });
    expect(missingRequestedTurnIds([a.id, "run-002"], decoded)).toEqual(["run-002"]);
    expect(missingRequestedTurnIds([a.id], decoded)).toEqual([]);
  });
});

describe("sortRunsByThreadOrder", () => {
  test("orders by created_at then id - the backend's thread order", () => {
    const a = wireRun(1);
    const b = wireRun(2);
    const tie = { ...wireRun(2), id: "run-002-b" };
    expect(sortRunsByThreadOrder([tie, b, a]).map((r) => r.id)).toEqual([a.id, b.id, tie.id]);
  });
});

describe("outlineStubTurn", () => {
  test("carries the skeleton and never renders live", () => {
    const stub = outlineStubTurn(
      outlineTurn(7, { status: "running", step_count: 12, has_summary: false }),
      "thread-root",
    );
    expect(stub.run.id).toBe("run-007");
    expect(stub.run.thread_id).toBe("thread-root");
    expect(stub.status).toBe("running");
    expect(stub.live).toBe(false); // stubs must never be forced real by the window
    expect(stub.steps).toEqual([]);
    expect(stub.pendingOutline).toEqual({ stepCount: 12, hasSummary: false });
  });
});
