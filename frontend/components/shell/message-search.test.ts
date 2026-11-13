import { describe, expect, test } from "bun:test";
import {
  decodeMessageMatches,
  fetchMessageMatches,
  type MessageMatch,
  messageMatchHref,
  messageSearchQuery,
  visibleMessageMatches,
} from "./message-search";

const WIRE = {
  thread_id: "thread-1",
  run_id: "run-2",
  thread_prompt: "Fix the flaky checkout test",
  role: "agent",
  snippet: "The checkout test raced the payment webhook.",
  created_at: "2026-11-01T10:00:00.000Z",
};

const MATCH: MessageMatch = {
  threadId: "thread-1",
  runId: "run-2",
  threadPrompt: "Fix the flaky checkout test",
  role: "agent",
  snippet: "The checkout test raced the payment webhook.",
  createdAt: "2026-11-01T10:00:00.000Z",
};

function respond(status: number, body: unknown) {
  const calls: string[] = [];
  const fetcher = async (path: string) => {
    calls.push(path);
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetcher };
}

describe("decodeMessageMatches", () => {
  test("reads the wire shape and drops rows it cannot read", () => {
    expect(
      decodeMessageMatches({
        matches: [WIRE, { ...WIRE, role: "system" }, { ...WIRE, run_id: 7 }, null],
      }),
    ).toEqual([MATCH]);
  });

  test("answers null for a body that is not a search answer", () => {
    expect(decodeMessageMatches(null)).toBeNull();
    expect(decodeMessageMatches({ error: "q is required" })).toBeNull();
    expect(decodeMessageMatches({ matches: "none" })).toBeNull();
  });
});

describe("fetchMessageMatches", () => {
  test("sends the query encoded and returns the matches", async () => {
    const { calls, fetcher } = respond(200, { matches: [WIRE] });
    expect(await fetchMessageMatches("pay & ship?", undefined, fetcher as never)).toEqual([MATCH]);
    expect(calls).toEqual(["/api/runs/search?q=pay%20%26%20ship%3F"]);
  });

  test("throws on a failed answer instead of reporting no matches", async () => {
    const failed = respond(503, { error: "Searching messages took too long. Try again." });
    await expect(fetchMessageMatches("pay", undefined, failed.fetcher as never)).rejects.toThrow(
      "503",
    );
    const odd = respond(200, { runs: [] });
    await expect(fetchMessageMatches("pay", undefined, odd.fetcher as never)).rejects.toThrow();
  });
});

describe("messageSearchQuery", () => {
  test("trims, skips queries under two characters and cuts to the backend's limit", () => {
    expect(messageSearchQuery("  webhook  ")).toBe("webhook");
    expect(messageSearchQuery(" a ")).toBe("");
    expect(messageSearchQuery("")).toBe("");
    expect(messageSearchQuery("ab")).toBe("ab");
    expect(messageSearchQuery("x".repeat(250))).toHaveLength(200);
  });
});

describe("visibleMessageMatches", () => {
  const rootPrompt: MessageMatch = { ...MATCH, runId: "thread-1", role: "user" };
  const otherThread: MessageMatch = {
    ...MATCH,
    threadId: "thread-9",
    runId: "thread-9",
    role: "user",
  };

  test("drops a thread's first prompt when the thread is already listed by title", () => {
    expect(visibleMessageMatches([rootPrompt, otherThread], new Set(["thread-1"]))).toEqual([
      otherThread,
    ]);
  });

  test("keeps the first prompt of a thread the title list does not show", () => {
    expect(visibleMessageMatches([rootPrompt], new Set())).toEqual([rootPrompt]);
  });

  test("keeps later messages and replies of a listed thread", () => {
    const reply: MessageMatch = { ...MATCH, runId: "thread-1", role: "agent" };
    expect(visibleMessageMatches([MATCH, reply], new Set(["thread-1"]))).toEqual([MATCH, reply]);
  });
});

test("messageMatchHref opens the thread at the matched turn", () => {
  expect(messageMatchHref(MATCH)).toBe("/session/thread-1?message=run-2");
});
