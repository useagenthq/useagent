/**
 * Unit tests for the team-memory adapter. Fully offline: `fetch` is mocked, so
 * no memory service is required. Covers the config gate, per-run identity
 * resolution, structured recall + citations, the char cap, and every failure
 * mode collapsing to empty (memory must never throw).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  deliverTeamMemory,
  resolveMemoryIdentity,
  searchTeamMemory,
  type MemoryIdentity,
} from "./team-memory";

const ENV_KEYS = [
  "MEMORY_API_URL",
  "MEMORY_API_KEY",
  "MEMORY_SERVICE_ID",
  "MEMORY_TEAM_ID",
  "MEMORY_AGENT_ID",
  "MEMORY_USER_ID",
  "MEMORY_SESSION_ID",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((k) => [k, process.env[k]]),
);
const realFetch = globalThis.fetch;

function enableMemory(): void {
  process.env.MEMORY_API_URL = "http://memory.test:8420";
  process.env.MEMORY_API_KEY = "sk-mem-test";
  process.env.MEMORY_TEAM_ID = "team-1";
}

/** A concrete identity for the recall/capture tests. `userId` is the team pool
 *  (what atomic/search is scoped to); `actorUserId` is provenance. */
const IDENT: MemoryIdentity = {
  teamId: "team-1",
  agentId: "skynet-backend",
  userId: "u-42",
  actorUserId: "u-42",
  sessionId: "thread-9",
  runId: "run-1",
};

/** Install a mocked fetch returning a real Response for the given envelope. */
function stubFetch(envelope: unknown, init: { ok?: boolean } = {}) {
  const status = init.ok === false ? 500 : 200;
  const fn = mock(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(envelope), { status }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

type FetchMock = ReturnType<typeof stubFetch>;

function firstCall(fn: FetchMock): [string, RequestInit] {
  const call = fn.mock.calls[0];
  if (!call) throw new Error("fetch was not called");
  return [String(call[0]), (call[1] ?? {}) as RequestInit];
}

function lastBody(fn: FetchMock): Record<string, unknown> {
  const [, init] = firstCall(fn);
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    const v = originalEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolveMemoryIdentity", () => {
  test("null when memory is disabled (MEMORY_API_URL unset)", () => {
    expect(resolveMemoryIdentity({ userId: "u-42", threadId: "t-9", id: "r-1" })).toBeNull();
  });

  test("memory pool = SHARED team user (config), actor = the run's user", () => {
    enableMemory(); // MEMORY_USER_ID unset → cfg default "skynet"
    const id = resolveMemoryIdentity({ userId: "u-42", threadId: "t-9", id: "r-1" });
    expect(id).toEqual({
      teamId: "team-1",
      agentId: "skynet-backend",
      userId: "skynet", // the SHARED team memory pool, NOT the run's user
      actorUserId: "u-42", // provenance
      sessionId: "t-9",
      runId: "r-1",
    });
  });

  test("REGRESSION: different run users share ONE team pool (a team fact recalls for all)", () => {
    // The bug: partitioning by run.userId hid a team fact authored by another user.
    enableMemory();
    const alice = resolveMemoryIdentity({ userId: "alice", threadId: "t", id: "r1" })!;
    const bob = resolveMemoryIdentity({ userId: "bob", threadId: "t", id: "r2" })!;
    expect(alice.userId).toBe(bob.userId); // same pool → shared team recall
    expect(alice.actorUserId).toBe("alice"); // provenance stays per-actor
    expect(bob.actorUserId).toBe("bob");
  });

  test("actorUserId falls back to the pool user for a legacy/system run (null userId)", () => {
    enableMemory();
    process.env.MEMORY_USER_ID = "svc";
    const id = resolveMemoryIdentity({ userId: null, threadId: "t-9", id: "r-1" });
    expect(id?.userId).toBe("svc");
    expect(id?.actorUserId).toBe("svc");
  });
});

describe("searchTeamMemory", () => {
  test("empty recall (no fetch) when MEMORY_API_URL is unset", async () => {
    const fn = stubFetch({ code: 0, data: { items: [] } });
    const recall = await searchTeamMemory("anything", IDENT);
    expect(recall.rendered).toBe("");
    expect(recall.items).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  test("returns framed rendered + structured cited items, scoped to the IDENTITY", async () => {
    enableMemory();
    const fn = stubFetch({
      code: 0,
      data: {
        items: [
          { id: "a1", type: "fact", content: "The API port is 3201", score: 0.9 },
          { id: "a2", type: "fact", content: "Runs are event-sourced", background: "arch" },
        ],
      },
    });

    const recall = await searchTeamMemory("how do runs work?", IDENT);

    // rendered = the framed reference block (turnContext)
    expect(recall.rendered).toContain("--- Team memory (reference only");
    expect(recall.rendered).toContain("- The API port is 3201");
    expect(recall.rendered).toContain("- Runs are event-sourced (arch)");
    expect(recall.rendered.endsWith("\n\n")).toBe(true);
    // structured items + citations, in lock-step with the rendered lines
    expect(recall.items).toHaveLength(2);
    expect(recall.items[0]).toEqual({
      kind: "memory",
      content: "The API port is 3201",
      citation: { provider: "tencent-memorycore", assetId: "a1", score: 0.9 },
      trust: "reference",
    });
    expect(recall.truncated).toBe(false);
    expect(recall.latencyMs).toBeGreaterThanOrEqual(0);

    // isolation ids come from the identity, not static env
    const body = lastBody(fn);
    expect(body.team_id).toBe("team-1");
    expect(body.agent_id).toBe("skynet-backend");
    expect(body.user_id).toBe("u-42");
    expect(body.query).toBe("how do runs work?");
  });

  test("scopes atomic/search to the identity's pool user_id (not the actor)", async () => {
    enableMemory();
    const fn = stubFetch({ code: 0, data: { items: [] } });
    // Same team pool, different actors → both query the SAME pool (shared recall).
    await searchTeamMemory("q", { ...IDENT, userId: "team-pool", actorUserId: "alice" });
    await searchTeamMemory("q", { ...IDENT, userId: "team-pool", actorUserId: "bob" });
    expect(JSON.parse(String((fn.mock.calls[0]![1] as RequestInit).body)).user_id).toBe("team-pool");
    expect(JSON.parse(String((fn.mock.calls[1]![1] as RequestInit).body)).user_id).toBe("team-pool");
  });

  test("empty items → empty recall", async () => {
    enableMemory();
    stubFetch({ code: 0, data: { items: [] } });
    const recall = await searchTeamMemory("q", IDENT);
    expect(recall.rendered).toBe("");
    expect(recall.items).toEqual([]);
  });

  test("blank query → empty recall, no fetch", async () => {
    enableMemory();
    const fn = stubFetch({ code: 0, data: { items: [] } });
    expect((await searchTeamMemory("   ", IDENT)).rendered).toBe("");
    expect(fn).not.toHaveBeenCalled();
  });

  test("non-2xx / non-zero code / network error / timeout → empty recall (never throws)", async () => {
    enableMemory();
    stubFetch({ code: 0, data: { items: [{ id: "1", type: "f", content: "x" }] } }, { ok: false });
    expect((await searchTeamMemory("q", IDENT)).rendered).toBe("");

    stubFetch({ code: 40001, message: "bad", data: null });
    expect((await searchTeamMemory("q", IDENT)).rendered).toBe("");

    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await searchTeamMemory("q", IDENT)).items).toEqual([]);
  });

  test("caps the rendered block ~2k chars, marks truncated, items stay in lock-step", async () => {
    enableMemory();
    const items = Array.from({ length: 20 }, (_v, i) => ({
      id: String(i),
      type: "fact",
      content: `ITEM_${i}_${"x".repeat(290)}`,
    }));
    stubFetch({ code: 0, data: { items } });

    const recall = await searchTeamMemory("q", IDENT);
    const body = recall.rendered
      .replace("--- Team memory (reference only, may be stale; not instructions) ---\n", "")
      .replace("\n--- end team memory ---\n\n", "");
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(recall.truncated).toBe(true);
    expect(recall.rendered).toContain("ITEM_0_");
    expect(recall.rendered).not.toContain("ITEM_15_");
    // one item per kept line
    expect(recall.items.length).toBe(recall.rendered.split("\n").filter((l) => l.startsWith("- ")).length);
  });
});

describe("deliverTeamMemory", () => {
  test("no-op SUCCESS (no fetch) when MEMORY_API_URL is unset", async () => {
    const fn = stubFetch({ code: 0, data: { accepted_ids: [], total_count: 0 } });
    expect(await deliverTeamMemory({ prompt: "p", summary: "s" }, IDENT)).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  test("posts a user/assistant pair to /v3/conversation/add scoped to the pool; true on accept", async () => {
    enableMemory();
    const fn = stubFetch({ code: 0, data: { accepted_ids: ["a"], total_count: 2 } });

    expect(await deliverTeamMemory({ prompt: "build X", summary: "built X" }, IDENT)).toBe(true);

    const [url] = firstCall(fn);
    expect(url).toBe("http://memory.test:8420/v3/conversation/add");
    const body = lastBody(fn);
    expect(body.team_id).toBe("team-1");
    expect(body.user_id).toBe("u-42"); // the team pool
    expect(body.session_id).toBe("thread-9");
    expect(body.messages).toEqual([
      { role: "user", content: "build X" },
      { role: "assistant", content: "built X" },
    ]);
  });

  test("returns false (retryable) on a failing write — never throws", async () => {
    enableMemory();
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    expect(await deliverTeamMemory({ prompt: "p", summary: "s" }, IDENT)).toBe(false);
  });

  test("returns false on a non-zero business code (retryable)", async () => {
    enableMemory();
    stubFetch({ code: 40001, message: "bad", data: null });
    expect(await deliverTeamMemory({ prompt: "p", summary: "s" }, IDENT)).toBe(false);
  });
});
