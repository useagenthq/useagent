// Unit tests for the retrieval-ledger payload builder (memory Phase 3a). Pure —
// no DB; the emit path (recordProviderEvent) is covered by the native-lane tests.
import { describe, expect, test } from "bun:test";
import { buildRetrievalPayload, CONTEXT_RETRIEVED } from "./retrieval-ledger";
import type { MemoryIdentity, MemoryRecall } from "./team-memory";

const identity: MemoryIdentity = {
  teamId: "team-1",
  agentId: "skynet-backend",
  userId: "u-42",
  sessionId: "thread-9",
  runId: "run-1",
};

const recall: MemoryRecall = {
  rendered: "--- Team memory (reference only) ---\n- fact one\n--- end ---\n\n",
  items: [
    {
      kind: "memory",
      content: "fact one",
      citation: { provider: "tencent-memorycore", assetId: "a1", score: 0.9 },
      trust: "reference",
    },
  ],
  truncated: false,
  latencyMs: 42,
};

describe("buildRetrievalPayload", () => {
  test("event type is the versioned context.retrieved marker", () => {
    expect(CONTEXT_RETRIEVED).toBe("context.retrieved");
  });

  test("captures scope, query, cited items, rendered chars, and latency", () => {
    const p = buildRetrievalPayload(identity, "what is fact one?", recall);
    expect(p.provider).toBe("tencent-memorycore");
    expect(p.query).toBe("what is fact one?");
    expect(p.scope).toEqual({
      teamId: "team-1",
      userId: "u-42",
      agentId: "skynet-backend",
      sessionId: "thread-9",
    });
    expect(p.itemCount).toBe(1);
    expect(p.items[0]).toEqual({
      content: "fact one",
      citation: { provider: "tencent-memorycore", assetId: "a1", score: 0.9 },
    });
    expect(p.renderedChars).toBe(recall.rendered.length);
    expect(p.truncated).toBe(false);
    expect(p.latencyMs).toBe(42);
  });

  test("scope carries only tenant ids — never transport credentials", () => {
    const p = buildRetrievalPayload(identity, "q", recall);
    expect(Object.keys(p.scope)).toEqual(["teamId", "userId", "agentId", "sessionId"]);
    const json = JSON.stringify(p);
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("Bearer");
  });
});
