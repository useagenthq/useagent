/**
 * Memory-scope policy tests (org vs personal). Two layers:
 *  1. resolveScopedMemory — pure pool resolution from a run's identity + scope.
 *  2. searchScopedMemory — the multi-pool recall, with a mocked atomic/search
 *     that honors the REAL strict per-user scoping (a fact recalls ONLY under the
 *     exact user_id it was written to), so cross-user isolation is provable
 *     offline.
 *
 * Covers spec tests 1–7 and the 9-validation guard; reply inheritance (8) and the
 * 400 on an invalid scope (9) live in runs-scope.test.ts; capture retry preserving
 * the destination scope (10) lives in capture-outbox.test.ts.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { isMemoryScope, resolveScopedMemory } from "./scope";
import { searchScopedMemory } from "./team-memory";

const ENV_KEYS = [
  "MEMORY_API_URL",
  "MEMORY_API_KEY",
  "MEMORY_SERVICE_ID",
  "MEMORY_TEAM_ID",
  "MEMORY_AGENT_ID",
  "MEMORY_USER_ID",
] as const;

const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

function enableMemory(): void {
  process.env.MEMORY_API_URL = "http://memory.test:8420";
  process.env.MEMORY_API_KEY = "sk-mem-test";
  // MEMORY_TEAM_ID intentionally unset → cfg default "skynet"; team_id must come
  // from the run's orgId, so the default never leaks into an org-scoped pool.
}

/** A mocked atomic/search that mirrors the service's strict per-user scoping: a
 *  fact recalls ONLY under the exact user_id it was written to. Records the
 *  (user_id, team_id) of every call so isolation can be asserted. */
function stubAtomicByUser(byUser: Record<string, { id: string; content: string }[]>) {
  const calls: { user_id: string; team_id: string }[] = [];
  const fn = mock(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { user_id: string; team_id: string };
    calls.push({ user_id: body.user_id, team_id: body.team_id });
    const items = (byUser[body.user_id] ?? []).map((h) => ({ id: h.id, type: "fact", content: h.content }));
    return new Response(JSON.stringify({ code: 0, data: { items } }), { status: 200 });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return { fn, calls };
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

describe("resolveScopedMemory", () => {
  test("null when memory is disabled (MEMORY_API_URL unset)", () => {
    expect(
      resolveScopedMemory({ orgId: "o", userId: "a", threadId: "t", id: "r", memoryScope: "org" }),
    ).toBeNull();
  });

  test("org scope: team_id = orgId, pool user_id = org:orgId; reads + writes org only", () => {
    enableMemory();
    const plan = resolveScopedMemory({
      orgId: "org-1",
      userId: "alice",
      threadId: "t",
      id: "r",
      memoryScope: "org",
    })!;
    expect(plan.scope).toBe("org");
    expect(plan.orgId).toBe("org-1");
    expect(plan.readPools).toHaveLength(1);
    expect(plan.readPools[0]!.sourceScope).toBe("org");
    expect(plan.readPools[0]!.identity.teamId).toBe("org-1"); // team_id = orgId, NOT cfg default
    expect(plan.readPools[0]!.identity.userId).toBe("org:org-1");
    expect(plan.writePool?.sourceScope).toBe("org");
    expect(plan.writePool?.identity.userId).toBe("org:org-1");
    expect(plan.actorUserId).toBe("alice"); // provenance only
  });

  test("(3,6) org pool is SHARED across members; org capture targets the org pool, never a personal one", () => {
    enableMemory();
    const a = resolveScopedMemory({ orgId: "org-1", userId: "alice", threadId: "t", id: "r1", memoryScope: "org" })!;
    const b = resolveScopedMemory({ orgId: "org-1", userId: "bob", threadId: "t", id: "r2", memoryScope: "org" })!;
    expect(a.readPools[0]!.identity.userId).toBe("org:org-1");
    expect(b.readPools[0]!.identity.userId).toBe("org:org-1"); // same shared partition (test 3)
    // org capture → org pool, never a personal (alice/bob) pool (test 6)
    expect(a.writePool?.identity.userId).toBe("org:org-1");
    expect(a.writePool?.identity.userId).not.toBe("alice");
  });

  test("(1,4,5) personal scope: reads [personal, org]; captures personal ONLY", () => {
    enableMemory();
    const plan = resolveScopedMemory({
      orgId: "org-1",
      userId: "alice",
      threadId: "t",
      id: "r",
      memoryScope: "personal",
    })!;
    expect(plan.scope).toBe("personal");
    // personal prioritized, org second (test 4)
    expect(plan.readPools.map((p) => p.sourceScope)).toEqual(["personal", "org"]);
    expect(plan.readPools[0]!.identity.userId).toBe("alice"); // personal pool = the user (test 1)
    expect(plan.readPools[1]!.identity.userId).toBe("org:org-1");
    // capture personal ONLY — never the shared org pool (test 5)
    expect(plan.writePool?.sourceScope).toBe("personal");
    expect(plan.writePool?.identity.userId).toBe("alice");
    expect(plan.writePool?.identity.userId).not.toBe("org:org-1");
  });

  test("(2) user B's pools address B — never A's personal pool", () => {
    enableMemory();
    const a = resolveScopedMemory({ orgId: "org-1", userId: "alice", threadId: "t", id: "r1", memoryScope: "personal" })!;
    const b = resolveScopedMemory({ orgId: "org-1", userId: "bob", threadId: "t", id: "r2", memoryScope: "personal" })!;
    const bUserIds = b.readPools.map((p) => p.identity.userId);
    expect(a.readPools.map((p) => p.identity.userId)).toContain("alice");
    expect(bUserIds).toContain("bob");
    expect(bUserIds).not.toContain("alice"); // B can never read A's personal pool
    expect(a.writePool?.identity.userId).toBe("alice");
    expect(b.writePool?.identity.userId).toBe("bob");
  });

  test("(7) personal run with NO authenticated user FAILS CLOSED — no read, no write", () => {
    enableMemory();
    const plan = resolveScopedMemory({ orgId: "org-1", userId: null, threadId: "t", id: "r", memoryScope: "personal" })!;
    expect(plan.scope).toBe("personal");
    expect(plan.readPools).toEqual([]);
    expect(plan.writePool).toBeNull();
    expect(plan.actorUserId).toBeNull();
  });

  test("legacy run with no org falls back to the configured default team pool", () => {
    enableMemory();
    process.env.MEMORY_TEAM_ID = "skynet";
    const plan = resolveScopedMemory({ orgId: null, userId: "alice", threadId: "t", id: "r", memoryScope: "org" })!;
    expect(plan.orgId).toBe("skynet");
    expect(plan.readPools[0]!.identity.userId).toBe("org:skynet");
  });

  test("product identity remains byte-for-byte unchanged when origin is null", () => {
    enableMemory();
    process.env.MEMORY_AGENT_ID = "agent-main";
    const plan = resolveScopedMemory({
      orgId: "org-1",
      userId: "alice",
      threadId: "thread-1",
      id: "run-1",
      memoryScope: "personal",
      origin: null,
    })!;
    expect(plan.agentId).toBe("agent-main");
    expect(plan.readPools.map((pool) => pool.identity)).toEqual([
      {
        teamId: "org-1",
        agentId: "agent-main",
        userId: "alice",
        actorUserId: "alice",
        sessionId: "thread-1",
        runId: "run-1",
      },
      {
        teamId: "org-1",
        agentId: "agent-main",
        userId: "org:org-1",
        actorUserId: "alice",
        sessionId: "thread-1",
        runId: "run-1",
      },
    ]);
  });

  test("the same internal origin shares one namespace across threads", () => {
    enableMemory();
    const first = resolveScopedMemory({
      orgId: "org-1",
      userId: "alice",
      threadId: "thread-a",
      id: "run-a",
      memoryScope: "org",
      origin: "internal:t3-parity",
    })!;
    const second = resolveScopedMemory({
      orgId: "org-1",
      userId: "alice",
      threadId: "thread-b",
      id: "run-b",
      memoryScope: "org",
      origin: "internal:t3-parity",
    })!;
    expect(first.agentId).toBe(second.agentId);
    expect(first.writePool?.identity.userId).toBe(second.writePool?.identity.userId);
    expect(first.writePool?.identity.sessionId).not.toBe(second.writePool?.identity.sessionId);
  });

  test("internal and product runs cannot address the same org or personal pools", () => {
    enableMemory();
    const product = resolveScopedMemory({
      orgId: "org-1",
      userId: "alice",
      threadId: "thread-product",
      id: "run-product",
      memoryScope: "personal",
      origin: null,
    })!;
    const internal = resolveScopedMemory({
      orgId: "org-1",
      userId: "alice",
      threadId: "thread-internal",
      id: "run-internal",
      memoryScope: "personal",
      origin: "internal:e2e",
    })!;
    expect(internal.agentId).not.toBe(product.agentId);
    expect(internal.readPools.map((pool) => pool.identity.userId)).not.toContain("alice");
    expect(internal.readPools.map((pool) => pool.identity.userId)).not.toContain("org:org-1");
  });

  test("internal namespaces preserve organization isolation", () => {
    enableMemory();
    const first = resolveScopedMemory({
      orgId: "org-1",
      userId: "alice",
      threadId: "thread-a",
      id: "run-a",
      memoryScope: "org",
      origin: "internal:canary",
    })!;
    const second = resolveScopedMemory({
      orgId: "org-2",
      userId: "alice",
      threadId: "thread-b",
      id: "run-b",
      memoryScope: "org",
      origin: "internal:canary",
    })!;
    expect(first.writePool?.identity.teamId).toBe("org-1");
    expect(second.writePool?.identity.teamId).toBe("org-2");
    expect(first.writePool?.identity.userId).not.toBe(second.writePool?.identity.userId);
  });
});

describe("isMemoryScope (validation guard for test 9)", () => {
  test("accepts the enum, rejects everything else", () => {
    expect(isMemoryScope("org")).toBe(true);
    expect(isMemoryScope("personal")).toBe(true);
    expect(isMemoryScope("team")).toBe(false);
    expect(isMemoryScope("")).toBe(false);
    expect(isMemoryScope(undefined)).toBe(false);
    expect(isMemoryScope(null)).toBe(false);
    expect(isMemoryScope(1)).toBe(false);
  });
});

describe("searchScopedMemory", () => {
  test("org scope: one fetch to the org pool; unlabeled block", async () => {
    enableMemory();
    const { calls } = stubAtomicByUser({ "org:org-1": [{ id: "o1", content: "org fact" }] });
    const plan = resolveScopedMemory({ orgId: "org-1", userId: "alice", threadId: "t", id: "r", memoryScope: "org" })!;
    const recall = await searchScopedMemory("q", plan.readPools);
    expect(calls.map((c) => c.user_id)).toEqual(["org:org-1"]);
    expect(calls[0]!.team_id).toBe("org-1");
    expect(recall.items).toHaveLength(1);
    expect(recall.items[0]!.sourceScope).toBe("org");
    expect(recall.rendered).toContain("- org fact");
    expect(recall.rendered).not.toContain("[org]"); // single scope → unlabeled
  });

  test("(4) personal scope: fetches personal + org; merges + LABELS each item", async () => {
    enableMemory();
    const { calls } = stubAtomicByUser({
      alice: [{ id: "p1", content: "personal fact" }],
      "org:org-1": [{ id: "o1", content: "org fact" }],
    });
    const plan = resolveScopedMemory({ orgId: "org-1", userId: "alice", threadId: "t", id: "r", memoryScope: "personal" })!;
    const recall = await searchScopedMemory("q", plan.readPools);
    expect(new Set(calls.map((c) => c.user_id))).toEqual(new Set(["alice", "org:org-1"]));
    expect(recall.items.map((i) => i.sourceScope).sort()).toEqual(["org", "personal"]);
    expect(recall.rendered).toContain("[personal] personal fact");
    expect(recall.rendered).toContain("[org] org fact");
  });

  test("(2) user B's personal search never surfaces A's personal fact", async () => {
    enableMemory();
    stubAtomicByUser({ alice: [{ id: "p1", content: "ALICE SECRET" }] }); // org pool empty
    const b = resolveScopedMemory({ orgId: "org-1", userId: "bob", threadId: "t", id: "r", memoryScope: "personal" })!;
    const recall = await searchScopedMemory("q", b.readPools);
    expect(recall.items).toEqual([]);
    expect(recall.rendered).toBe("");
    expect(recall.rendered).not.toContain("ALICE SECRET");
  });

  test("(3) A and B both recall the shared org fact", async () => {
    enableMemory();
    stubAtomicByUser({ "org:org-1": [{ id: "o1", content: "SHARED ORG FACT" }] });
    for (const user of ["alice", "bob"]) {
      const plan = resolveScopedMemory({ orgId: "org-1", userId: user, threadId: "t", id: "r", memoryScope: "org" })!;
      const recall = await searchScopedMemory("q", plan.readPools);
      expect(recall.rendered).toContain("SHARED ORG FACT");
    }
  });

  test("fail-closed personal (pools = []) → no fetch, empty recall", async () => {
    enableMemory();
    const { fn } = stubAtomicByUser({});
    const plan = resolveScopedMemory({ orgId: "org-1", userId: null, threadId: "t", id: "r", memoryScope: "personal" })!;
    const recall = await searchScopedMemory("q", plan.readPools);
    expect(fn).not.toHaveBeenCalled();
    expect(recall.rendered).toBe("");
  });

  test("dedupe across pools: a fact in both personal + org appears once (personal wins)", async () => {
    enableMemory();
    stubAtomicByUser({
      alice: [{ id: "p1", content: "same fact" }],
      "org:org-1": [{ id: "o1", content: "Same Fact" }], // case-different duplicate
    });
    const plan = resolveScopedMemory({ orgId: "org-1", userId: "alice", threadId: "t", id: "r", memoryScope: "personal" })!;
    const recall = await searchScopedMemory("q", plan.readPools);
    expect(recall.items).toHaveLength(1);
    expect(recall.items[0]!.sourceScope).toBe("personal"); // first pool wins
  });
});
