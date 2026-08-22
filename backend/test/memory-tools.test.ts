import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { providerEvents, runs } from "../src/db/schema";
import { executeMemoryTool, MEMORY_EVENTS } from "../src/knowledge/gateway/memory-tools";
import { parseEnvelope } from "../src/memory/explicit-memory";
import type { ToolTokenClaims } from "../src/knowledge/gateway/token";
import { uid } from "./helpers";

// Gateway MEMORY tools (new_mem_prompt.md 5-7): identity/scope resolved SERVER-side
// from the run, synchronous Tencent L0 write returns a real receipt, recall reads
// L0 immediately, idempotency reconciles, the trust boundary fails closed, and a
// provider failure never fakes "saved". Tencent is mocked STATEFULLY so the tool
// logic is exercised end to end without the live gateway (the live proof is #92).

const realFetch = globalThis.fetch;
const originalMemoryEnv = {
  MEMORY_API_KEY: process.env.MEMORY_API_KEY,
  MEMORY_API_URL: process.env.MEMORY_API_URL,
  MEMORY_TEAM_ID: process.env.MEMORY_TEAM_ID,
};

function restoreEnv(
  key: keyof typeof originalMemoryEnv,
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}

/** A stateful in-memory Tencent v3, keyed by user_id (pool), so remember -> search
 *  works and idempotency can find a prior write. */
function tencentMock() {
  const msgs: Array<{ id: string; user_id: string; role: string; content: string }> = [];
  const state = { fail: false };
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    if (state.fail) return new Response("upstream down", { status: 502 });
    if (u.endsWith("/v3/conversation/add")) {
      const added = (body.messages as any[]).map((m, i) => ({
        id: `msg-${msgs.length + i}`,
        user_id: body.user_id,
        role: m.role,
        content: m.content,
      }));
      msgs.push(...added);
      return jsonResponse({ code: 0, data: { accepted_ids: added.map((a) => a.id), total_count: added.length } });
    }
    if (u.endsWith("/v3/conversation/search")) {
      const q = String(body.query ?? "").toLowerCase();
      const hits = msgs
        .filter((m) => m.user_id === body.user_id)
        .filter((m) => q.length < 3 || m.content.toLowerCase().includes(q) || q.includes("favourite"))
        .map((m) => ({ id: m.id, role: m.role, content: m.content, score: 0.9 }));
      return jsonResponse({ code: 0, data: { messages: hits } });
    }
    if (u.endsWith("/v3/atomic/search")) return jsonResponse({ code: 0, data: { items: [] } });
    // L1 delete works on the real build; L1 update works for personal pools.
    if (u.endsWith("/v3/atomic/delete")) {
      return jsonResponse({ code: 0, data: { deleted_count: (body.ids as string[])?.length ?? 0 } });
    }
    if (u.endsWith("/v3/atomic/update")) return jsonResponse({ code: 0, data: { id: body.id, updated_at: "t" } });
    // L0 hard-delete is a no-op on the installed build (deleted_count 0).
    if (u.endsWith("/v3/conversation/delete")) return jsonResponse({ code: 0, data: { deleted_count: 0 } });
    return jsonResponse({ code: 0, data: {} });
  }) as unknown as typeof fetch;
  return { fetchImpl, msgs, state };
}

async function insertRun(input: {
  orgId: string | null;
  userId: string | null;
  scope: "org" | "personal";
  origin?: string | null;
}): Promise<{ id: string; threadId: string }> {
  const id = uid("run");
  await db.insert(runs).values({
    id,
    prompt: "hi",
    model: "claude-opus-5",
    engine: "opencode",
    status: "running",
    threadId: id,
    orgId: input.orgId,
    userId: input.userId,
    memoryScope: input.scope,
    origin: input.origin ?? null,
  });
  return { id, threadId: id };
}

function claimsFor(run: { id: string; threadId: string }, orgId: string, userId = "u-1"): ToolTokenClaims {
  return { orgId, userId, threadId: run.threadId, runId: run.id, exp: Date.now() + 60_000 };
}

/** Provider events are emitted fire-and-forget (never block the tool), so poll
 *  briefly for the durable row instead of asserting synchronously. */
async function eventsFor(runId: string, type: string) {
  for (let i = 0; i < 40; i++) {
    const rows = await db
      .select()
      .from(providerEvents)
      .where(and(eq(providerEvents.runId, runId), eq(providerEvents.eventType, type)));
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return [];
}

beforeEach(() => {
  process.env.MEMORY_API_URL = "http://memory.test:8420";
  process.env.MEMORY_API_KEY = "sk-mem-test";
  process.env.MEMORY_TEAM_ID = "skynet";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(originalMemoryEnv)) {
    restoreEnv(key as keyof typeof originalMemoryEnv, value);
  }
});

describe("memory_remember", () => {
  test("writes a Tencent L0 explicit-memory envelope and reports saved", async () => {
    const mock = tencentMock();
    globalThis.fetch = mock.fetchImpl;
    const run = await insertRun({ orgId: "org-1", userId: "u-1", scope: "org" });

    const res = await executeMemoryTool(claimsFor(run, "org-1"), "memory_remember", {
      content: "The user's favourite color is teal.",
      kind: "preference",
      key: "favourite_color",
    });

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.saved).toBe(true);
    expect(res.structuredContent?.scope).toBe("org");
    expect(String(res.structuredContent?.refs)).toContain("tencent:l0:");
    // The message sent to Tencent is a well-formed envelope carrying the content.
    const env = parseEnvelope(mock.msgs[0]!.content);
    expect(env?.content).toBe("The user's favourite color is teal.");
    expect(env?.kind).toBe("preference");
    expect(env?.state).toBe("active");
    // wrote into the ORG pool partition
    expect(mock.msgs[0]!.user_id).toBe("org:org-1");
    // truthful L0-accepted event
    expect((await eventsFor(run.id, MEMORY_EVENTS.l0Accepted)).length).toBe(1);
  });

  test("is idempotent by operationId (no duplicate)", async () => {
    const mock = tencentMock();
    globalThis.fetch = mock.fetchImpl;
    const run = await insertRun({ orgId: "org-2", userId: "u-1", scope: "org" });
    const args = { content: "Blue is the color.", idempotencyKey: "op-fixed-1" };

    const a = await executeMemoryTool(claimsFor(run, "org-2"), "memory_remember", args);
    const b = await executeMemoryTool(claimsFor(run, "org-2"), "memory_remember", args);
    expect(a.structuredContent?.saved).toBe(true);
    expect(b.structuredContent?.reconciled).toBe(true);
    expect(mock.msgs.length).toBe(1); // second call did NOT write again
  });

  test("a provider failure never reports saved", async () => {
    const mock = tencentMock();
    mock.state.fail = true;
    globalThis.fetch = mock.fetchImpl;
    const run = await insertRun({ orgId: "org-3", userId: "u-1", scope: "org" });

    const res = await executeMemoryTool(claimsFor(run, "org-3"), "memory_remember", { content: "x" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.saved).toBe(false);
    expect((await eventsFor(run.id, MEMORY_EVENTS.failed)).length).toBe(1);
  });

  test("personal scope with no authenticated user fails closed", async () => {
    const mock = tencentMock();
    globalThis.fetch = mock.fetchImpl;
    const run = await insertRun({ orgId: "org-4", userId: null, scope: "personal" });

    const res = await executeMemoryTool(claimsFor(run, "org-4", ""), "memory_remember", { content: "secret pref" });
    expect(res.isError).toBe(true);
    expect(mock.msgs.length).toBe(0); // nothing written
  });
});

describe("memory_search", () => {
  test("recalls a just-remembered fact immediately from L0", async () => {
    const mock = tencentMock();
    globalThis.fetch = mock.fetchImpl;
    const run = await insertRun({ orgId: "org-5", userId: "u-1", scope: "org" });
    await executeMemoryTool(claimsFor(run, "org-5"), "memory_remember", {
      content: "The user's favourite color is teal.",
      key: "favourite_color",
    });

    const res = await executeMemoryTool(claimsFor(run, "org-5"), "memory_search", {
      query: "what is my favourite color",
    });
    const items = (res.structuredContent?.items ?? []) as Array<{ content: string; layer: string; ref: string }>;
    expect(items.some((i) => i.content.includes("teal"))).toBe(true);
    expect(items[0]?.layer).toBe("l0");
    expect(items[0]?.ref).toContain("tencent:l0:");
    expect((await eventsFor(run.id, MEMORY_EVENTS.searched)).length).toBe(1);
  });

  test("a provider OUTAGE reports unavailable, not a fake 0-hit (5.2)", async () => {
    const mock = tencentMock();
    mock.state.fail = true; // every call 502 -> unreachable
    globalThis.fetch = mock.fetchImpl;
    const run = await insertRun({ orgId: "org-11", userId: "u-1", scope: "org" });
    const res = await executeMemoryTool(claimsFor(run, "org-11"), "memory_search", { query: "anything" });
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.degraded).toBe(true);
    // memory.failed op:search (drives the "unavailable" chip), NOT memory.searched.
    const failed = await eventsFor(run.id, MEMORY_EVENTS.failed);
    expect(failed.length).toBe(1);
    expect(JSON.parse(failed[0].payload).op).toBe("search");
    expect((await eventsFor(run.id, MEMORY_EVENTS.searched)).length).toBe(0);
  });
});

describe("memory_read", () => {
  test("reads L2 scenes and L3 persona inside the run's organization scope", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ path, body });
      if (path === "/v3/scenario/read") {
        return jsonResponse({ code: 0, data: { path: body.path, content: "deployment scene" } });
      }
      if (path === "/v3/core/read") {
        return jsonResponse({ code: 0, data: { content: "organization persona" } });
      }
      return jsonResponse({ code: 0, data: {} });
    }) as typeof fetch;
    const run = await insertRun({ orgId: "org-12", userId: "u-1", scope: "org" });
    const claims = claimsFor(run, "org-12");

    const scene = await executeMemoryTool(claims, "memory_read", {
      memoryRef: "tencent:l2:deployments.md",
    });
    const persona = await executeMemoryTool(claims, "memory_read", {
      memoryRef: "tencent:l3:core",
    });

    expect(scene.content[0]?.text).toBe("deployment scene");
    expect(persona.content[0]?.text).toBe("organization persona");
    expect(calls).toEqual([
      {
        path: "/v3/scenario/read",
        body: {
          team_id: "org-12",
          agent_id: "skynet-backend",
          user_id: "org:org-12",
          path: "deployments.md",
        },
      },
      {
        path: "/v3/core/read",
        body: {
          team_id: "org-12",
          agent_id: "skynet-backend",
          user_id: "org:org-12",
        },
      },
    ]);
  });
});

describe("memory_correct / memory_forget", () => {
  test("correcting an internal ORG L1 ref still uses replace-then-delete", async () => {
    const mock = tencentMock();
    globalThis.fetch = mock.fetchImpl;
    const run = await insertRun({
      orgId: "org-internal",
      userId: "u-1",
      scope: "org",
      origin: "internal:t3-parity",
    });
    const res = await executeMemoryTool(claimsFor(run, "org-internal"), "memory_correct", {
      memoryRef: "tencent:l1:fact-internal",
      content: "The corrected internal fact.",
    });
    expect(res.isError).toBeUndefined();
    expect(mock.msgs.some((m) => m.content.includes("The corrected internal fact."))).toBe(true);
    expect(String(res.structuredContent?.ref)).toContain("tencent:l0:");
  });

  test("correcting an ORG L1 ref replaces-then-deletes (avoids the atomic/update 403)", async () => {
    const mock = tencentMock();
    globalThis.fetch = mock.fetchImpl;
    const run = await insertRun({ orgId: "org-8", userId: "u-1", scope: "org" });
    const res = await executeMemoryTool(claimsFor(run, "org-8"), "memory_correct", {
      memoryRef: "tencent:l1:fact-xyz",
      content: "The corrected fact.",
    });
    expect(res.isError).toBeUndefined();
    // wrote a NEW L0 explicit memory as the replacement
    expect(mock.msgs.some((m) => m.content.includes("The corrected fact."))).toBe(true);
    expect(String(res.structuredContent?.ref)).toContain("tencent:l0:");
    expect((await eventsFor(run.id, MEMORY_EVENTS.updated)).length).toBe(1);
  });

  test("forgetting an L1 ref deletes it and reports removed", async () => {
    const mock = tencentMock();
    globalThis.fetch = mock.fetchImpl;
    const run = await insertRun({ orgId: "org-9", userId: "u-1", scope: "org" });
    const res = await executeMemoryTool(claimsFor(run, "org-9"), "memory_forget", {
      memoryRef: "tencent:l1:fact-1",
    });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.removed).toBe(1);
    expect((await eventsFor(run.id, MEMORY_EVENTS.deleted)).length).toBe(1);
  });

  test("forgetting an L0 ref is honest when the build cannot hard-delete", async () => {
    const mock = tencentMock();
    globalThis.fetch = mock.fetchImpl;
    const run = await insertRun({ orgId: "org-10", userId: "u-1", scope: "org" });
    const res = await executeMemoryTool(claimsFor(run, "org-10"), "memory_forget", {
      memoryRef: "tencent:l0:msg-0",
    });
    expect(res.isError).toBe(true); // never claims a clean deletion
    expect(res.structuredContent?.removed).toBe(0);
    expect(String(res.content[0]?.text)).toContain("memory_correct");
  });
});

describe("trust boundary", () => {
  test("a token whose thread does not match the run fails closed", async () => {
    const mock = tencentMock();
    globalThis.fetch = mock.fetchImpl;
    const run = await insertRun({ orgId: "org-6", userId: "u-1", scope: "org" });
    // Token carries the right org + runId but a DIFFERENT thread → not our run.
    const badThread: ToolTokenClaims = { orgId: "org-6", userId: "u-1", threadId: "someone-elses-thread", runId: run.id, exp: Date.now() + 60_000 };
    const res = await executeMemoryTool(badThread, "memory_remember", { content: "leak" });
    expect(res.isError).toBe(true);
    expect(mock.msgs.length).toBe(0);
  });

  test("a token whose org does not match the run fails closed", async () => {
    const mock = tencentMock();
    globalThis.fetch = mock.fetchImpl;
    const run = await insertRun({ orgId: "org-7", userId: "u-1", scope: "org" });
    const badOrg = claimsFor(run, "org-DIFFERENT");
    const res = await executeMemoryTool(badOrg, "memory_remember", { content: "cross-org" });
    expect(res.isError).toBe(true);
    expect(mock.msgs.length).toBe(0);
  });
});
