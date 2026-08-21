/**
 * Unit tests for the team-memory adapter (single-pool primitives). Fully offline:
 * `fetch` is mocked, so no memory service is required. Covers the config gate,
 * structured recall + citations, the char cap, and every failure mode collapsing
 * to empty (memory must never throw). Scope/pool policy is covered in scope.test.ts.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  BLOCK_FOOTER,
  BLOCK_HEADER,
  deliverTeamMemory,
  recallScopedMemory,
  readOrgScenarioMemory,
  searchTeamMemory,
  type MemoryIdentity,
  type ScopedPool,
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
    // Strip the REAL exported markers - a hardcoded copy drifted once when the
    // header grew its self-attribution clause and silently broke the cap check.
    const body = recall.rendered
      .replace(`${BLOCK_HEADER}\n`, "")
      .replace(`\n${BLOCK_FOOTER}\n\n`, "");
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

describe("recallScopedMemory (layered L0-L3) degrades honestly", () => {
  const pool: ScopedPool = { sourceScope: "org", identity: IDENT };

  test("reproducible Tencent layer matrix: L0/L1/L2/L3 calls, citations, org isolation, dedupe, budget, degradation", async () => {
    enableMemory();
    const personal: ScopedPool = {
      sourceScope: "personal",
      identity: { ...IDENT, userId: "alice", actorUserId: "alice" },
    };
    const org: ScopedPool = {
      sourceScope: "org",
      identity: { ...IDENT, teamId: "org-1", userId: "org:org-1", actorUserId: "alice" },
    };
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/v3/conversation/search" && body.user_id === "alice") {
        return new Response(JSON.stringify({ code: 0, data: { messages: [{ id: "l0p", content: "same memory", score: 0.99 }] } }));
      }
      if (path === "/v3/atomic/search" && body.user_id === "alice") {
        return new Response(JSON.stringify({ code: 0, data: { items: [{ id: "l1p", type: "fact", content: "same memory", score: 0.5 }] } }));
      }
      if (path === "/v3/conversation/search" && body.user_id === "org:org-1") {
        return new Response(JSON.stringify({ code: 0, data: { messages: [{ id: "l0o", content: "org immediate fact", score: 0.7 }] } }));
      }
      if (path === "/v3/atomic/search" && body.user_id === "org:org-1") {
        return new Response(JSON.stringify({ code: 0, data: { items: [{ id: "l1o", type: "fact", content: "org distilled fact", score: 0.6 }] } }));
      }
      if (path === "/v3/scenario/ls") {
        expect(body).toMatchObject({ agent_id: "skynet-backend", user_id: `org:${body.team_id}`, path_prefix: "" });
        expect(body).not.toHaveProperty("query");
        expect(body).not.toHaveProperty("limit");
        expect(body).not.toHaveProperty("session_id");
        const prefix = body.team_id === "org-2" ? "other" : "org";
        return new Response(JSON.stringify({
          code: 0,
          data: {
            entries: [
              { path: `${prefix}/low`, summary: "unrelated archive", version: 1 },
              { path: `${prefix}/deploy`, summary: "deployment episode", version: 2 },
              { path: `${prefix}/matrix`, summary: "matrix validation notes", version: 3 },
            ],
            total: 3,
          },
        }));
      }
      if (path === "/v3/scenario/read") {
        expect(body).toMatchObject({ agent_id: "skynet-backend", user_id: `org:${body.team_id}` });
        expect(body).toHaveProperty("path");
        expect(body).not.toHaveProperty("id");
        const scene = body.team_id === "org-2" ? "second org scene summary" : `org scene ${body.path}`;
        return new Response(JSON.stringify({ code: 0, data: { path: body.path, content: scene } }));
      }
      if (path === "/v3/core/read") {
        expect(body).toMatchObject({ agent_id: "skynet-backend", user_id: `org:${body.team_id}` });
        return new Response(JSON.stringify({ code: 0, data: { content: `${body.team_id} bounded org persona` } }));
      }
      return new Response(JSON.stringify({ code: 0, data: {} }));
    }) as unknown as typeof fetch;

    const recall = await recallScopedMemory("deploy matrix", [personal, org], { limit: 6 });

    expect(calls.map((c) => c.path).sort()).toEqual([
      "/v3/atomic/search",
      "/v3/atomic/search",
      "/v3/conversation/search",
      "/v3/conversation/search",
      "/v3/core/read",
      "/v3/scenario/ls",
    ]);
    expect(calls.filter((c) => c.path === "/v3/core/read")).toHaveLength(1);
    expect(calls.filter((c) => c.path === "/v3/scenario/ls")).toHaveLength(1);
    expect(recall.items.map((i) => i.citation.ref)).toEqual([
      "tencent:l0:l0p",
      "tencent:l0:l0o",
      "tencent:l1:l1o",
      "tencent:l2:org/deploy",
      "tencent:l2:org/matrix",
      "tencent:l3:core",
    ]);
    expect(recall.items.map((i) => i.citation.layer)).toEqual(["l0", "l0", "l1", "l2", "l2", "l3"]);
    expect(recall.items.map((i) => i.sourceScope)).toEqual(["personal", "org", "org", "org", "org", "org"]);
    expect(recall.rendered).toContain("[personal] same memory");
    expect(recall.rendered).toContain("[org] deployment episode");
    expect(recall.rendered).toContain("[org] matrix validation notes");
    expect(recall.rendered).not.toContain("org/low");
    expect(recall.rendered).toContain("[org] org-1 bounded org persona");
    expect(recall.rendered.match(/same memory/g)).toHaveLength(1);
    expect(recall.truncated).toBe(false);
    expect(recall.degraded).toBe(false);

    const fullScene = await readOrgScenarioMemory(org.identity, "org/deploy");
    expect(fullScene.hit?.content).toBe("org scene org/deploy");
    expect(calls.at(-1)?.path).toBe("/v3/scenario/read");

    calls.length = 0;
    const org2: ScopedPool = {
      sourceScope: "org",
      identity: { ...IDENT, teamId: "org-2", userId: "org:org-2", actorUserId: "carol" },
    };
    const org2Recall = await recallScopedMemory("deploy matrix", [org2], { limit: 6 });
    expect(org2Recall.rendered).toContain("org-2 bounded org persona");
    expect(calls.filter((c) => ["/v3/scenario/ls", "/v3/scenario/read", "/v3/core/read"].includes(c.path)).map((c) => c.body.team_id)).toEqual([
      "org-2",
      "org-2",
    ]);
    expect(calls.filter((c) => ["/v3/scenario/ls", "/v3/scenario/read", "/v3/core/read"].includes(c.path)).map((c) => c.body.user_id)).toEqual([
      "org:org-2",
      "org:org-2",
    ]);

    globalThis.fetch = (async () => {
      throw new Error("provider down");
    }) as unknown as typeof fetch;
    const down = await recallScopedMemory("q", [personal, org]);
    expect(down.items).toEqual([]);
    expect(down.degraded).toBe(true);
  });

  test("a provider outage yields an EMPTY, DEGRADED recall and never throws", async () => {
    enableMemory();
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const recall = await recallScopedMemory("anything", [pool]);
    expect(recall.rendered).toBe("");
    expect(recall.items).toEqual([]);
    expect(recall.degraded).toBe(true); // unreachable, NOT a genuine 0-hit
  });

  test("a reachable-but-empty provider is NOT degraded (genuine 0-hit)", async () => {
    enableMemory();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 0, data: { items: [], messages: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const recall = await recallScopedMemory("anything", [pool]);
    expect(recall.items).toEqual([]);
    expect(recall.degraded).toBe(false);
  });

  test("disabled memory is a fast empty no-op with no fetch", async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const recall = await recallScopedMemory("anything", [pool]);
    expect(recall.rendered).toBe("");
    expect(recall.items).toEqual([]);
    expect(recall.degraded).toBe(false);
    expect(called).toBe(false);
  });
});
