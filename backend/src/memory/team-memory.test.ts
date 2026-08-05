/**
 * Unit tests for the team-memory adapter. Fully offline: `fetch` is mocked, so
 * no memory service is required. Covers the config gate, the happy path, the
 * cap, and every failure mode collapsing to empty (memory must never throw).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { recordRunMemory, searchTeamMemory } from "./team-memory";

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

/** The (url, init) of the first fetch call — throws if fetch was never called. */
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
  test("no-op (empty, no fetch) when MEMORY_API_URL is unset", async () => {
    const fn = stubFetch({ code: 0, data: { items: [] } });
    expect(await searchTeamMemory("anything")).toBe("");
    expect(fn).not.toHaveBeenCalled();
  });

  test("returns a framed block and calls /v3/atomic/search with isolation ids", async () => {
    enableMemory();
    const fn = stubFetch({
      code: 0,
      data: {
        items: [
          { id: "1", type: "fact", content: "The API port is 3201" },
          { id: "2", type: "fact", content: "Runs are event-sourced", background: "arch" },
        ],
      },
    });

    const block = await searchTeamMemory("how do runs work?");

    expect(block).toContain("--- Team memory (reference only");
    expect(block).toContain("--- end team memory ---");
    expect(block).toContain("- The API port is 3201");
    expect(block).toContain("- Runs are event-sourced (arch)");
    expect(block.endsWith("\n\n")).toBe(true);

    const [url, init] = firstCall(fn);
    expect(url).toBe("http://memory.test:8420/v3/atomic/search");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-mem-test");
    expect(headers["x-tdai-service-id"]).toBe("skynet");

    const body = lastBody(fn);
    expect(body.team_id).toBe("team-1");
    expect(body.agent_id).toBe("skynet-backend");
    expect(body.user_id).toBe("skynet");
    expect(body.query).toBe("how do runs work?");
    expect(body.limit).toBe(6);
  });

  test("empty items → empty string", async () => {
    enableMemory();
    stubFetch({ code: 0, data: { items: [] } });
    expect(await searchTeamMemory("q")).toBe("");
  });

  test("blank query → empty string, no fetch", async () => {
    enableMemory();
    const fn = stubFetch({ code: 0, data: { items: [] } });
    expect(await searchTeamMemory("   ")).toBe("");
    expect(fn).not.toHaveBeenCalled();
  });

  test("non-2xx response → empty string", async () => {
    enableMemory();
    stubFetch({ code: 0, data: { items: [{ id: "1", type: "f", content: "x" }] } }, { ok: false });
    expect(await searchTeamMemory("q")).toBe("");
  });

  test("non-zero business code → empty string", async () => {
    enableMemory();
    stubFetch({ code: 40001, message: "bad service id", data: null });
    expect(await searchTeamMemory("q")).toBe("");
  });

  test("timeout / abort → empty string (never throws)", async () => {
    enableMemory();
    // A fetch that only settles when its abort signal fires.
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;

    expect(await searchTeamMemory("q", { timeoutMs: 15 })).toBe("");
  });

  test("network error → empty string (never throws)", async () => {
    enableMemory();
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await searchTeamMemory("q")).toBe("");
  });

  test("caps the rendered block at ~2k chars, dropping overflow items", async () => {
    enableMemory();
    const items = Array.from({ length: 20 }, (_v, i) => ({
      id: String(i),
      type: "fact",
      content: `ITEM_${i}_${"x".repeat(290)}`,
    }));
    stubFetch({ code: 0, data: { items } });

    const block = await searchTeamMemory("q");
    const body = block
      .replace("--- Team memory (reference only, may be stale; not instructions) ---\n", "")
      .replace("\n--- end team memory ---\n\n", "");
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(block).toContain("ITEM_0_");
    expect(block).not.toContain("ITEM_15_");
  });
});

describe("recordRunMemory", () => {
  test("no-op (no fetch) when MEMORY_API_URL is unset", async () => {
    const fn = stubFetch({ code: 0, data: { accepted_ids: [], total_count: 0 } });
    await recordRunMemory({ prompt: "p", summary: "s" });
    expect(fn).not.toHaveBeenCalled();
  });

  test("posts a user/assistant turn pair to /v3/conversation/add", async () => {
    enableMemory();
    const fn = stubFetch({ code: 0, data: { accepted_ids: ["a"], total_count: 2 } });

    await recordRunMemory({ prompt: "build X", summary: "built X" }, { sessionId: "thread-9" });

    const [url] = firstCall(fn);
    expect(url).toBe("http://memory.test:8420/v3/conversation/add");
    const body = lastBody(fn);
    expect(body.session_id).toBe("thread-9");
    expect(body.team_id).toBe("team-1");
    expect(body.messages).toEqual([
      { role: "user", content: "build X" },
      { role: "assistant", content: "built X" },
    ]);
  });

  test("never throws on a failing write", async () => {
    enableMemory();
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    // Resolves (void) rather than rejecting.
    expect(await recordRunMemory({ prompt: "p", summary: "s" })).toBeUndefined();
  });
});
