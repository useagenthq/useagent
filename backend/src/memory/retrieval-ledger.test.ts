// Unit tests for the retrieval-ledger payload builder (memory Phase 3a, scope-
// aware). Pure — no DB; the emit path (recordProviderEvent) is covered by the
// native-lane tests.
import { describe, expect, test } from "bun:test";
import { buildRetrievalPayload, CONTEXT_RETRIEVED } from "./retrieval-ledger";
import type { ScopedMemoryPlan } from "./scope";
import type { ScopedRecall } from "./team-memory";

/** A personal-scope plan: reads personal + org, captures personal. */
const plan: ScopedMemoryPlan = {
  scope: "personal",
  orgId: "org-1",
  agentId: "skynet-backend",
  sessionId: "thread-9",
  actorUserId: "u-42",
  readPools: [
    { sourceScope: "personal", identity: { teamId: "org-1", agentId: "skynet-backend", userId: "u-42", actorUserId: "u-42", sessionId: "thread-9", runId: "run-1" } },
    { sourceScope: "org", identity: { teamId: "org-1", agentId: "skynet-backend", userId: "org:org-1", actorUserId: "u-42", sessionId: "thread-9", runId: "run-1" } },
  ],
  writePool: { sourceScope: "personal", identity: { teamId: "org-1", agentId: "skynet-backend", userId: "u-42", actorUserId: "u-42", sessionId: "thread-9", runId: "run-1" } },
};

const recall: ScopedRecall = {
  rendered: "--- Team memory (reference only) ---\n- [personal] fact one\n- [org] fact two\n--- end ---\n\n",
  items: [
    {
      kind: "memory",
      content: "fact one",
      sourceScope: "personal",
      citation: { provider: "tencent-memorycore", assetId: "a1", score: 0.9 },
      trust: "reference",
    },
    {
      kind: "memory",
      content: "fact two",
      sourceScope: "org",
      citation: { provider: "tencent-memorycore", assetId: "a2", score: 0.5 },
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

  test("captures memoryScope, scope, per-item sourceScope, rendered chars, latency", () => {
    const p = buildRetrievalPayload(plan, "what is fact one?", recall);
    expect(p.provider).toBe("tencent-memorycore");
    expect(p.query).toBe("what is fact one?");
    expect(p.memoryScope).toBe("personal");
    expect(p.scope).toEqual({
      orgId: "org-1",
      actorUserId: "u-42",
      agentId: "skynet-backend",
      sessionId: "thread-9",
    });
    expect(p.itemCount).toBe(2);
    expect(p.items[0]).toEqual({
      content: "fact one",
      sourceScope: "personal",
      citation: { provider: "tencent-memorycore", assetId: "a1", score: 0.9 },
    });
    expect(p.items[1]!.sourceScope).toBe("org");
    expect(p.renderedChars).toBe(recall.rendered.length);
    expect(p.truncated).toBe(false);
    expect(p.latencyMs).toBe(42);
  });

  test("scope carries only tenant ids — never transport credentials", () => {
    const p = buildRetrievalPayload(plan, "q", recall);
    expect(Object.keys(p.scope)).toEqual(["orgId", "actorUserId", "agentId", "sessionId"]);
    const json = JSON.stringify(p);
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("Bearer");
    expect(json).not.toContain("Authorization");
  });

  test("org-scope plan records actorUserId as provenance (null when unauthenticated)", () => {
    const orgPlan: ScopedMemoryPlan = { ...plan, scope: "org", actorUserId: null };
    const p = buildRetrievalPayload(orgPlan, "q", recall);
    expect(p.memoryScope).toBe("org");
    expect(p.scope.actorUserId).toBeNull();
  });
});
