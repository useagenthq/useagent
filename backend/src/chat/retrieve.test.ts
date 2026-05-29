/**
 * Chat context assembly (#122). Exercises retrieveChatContext with FAKE
 * knowledge-search + memory-recall deps, so the combine/render/citation logic is
 * provable offline with no DB or memory service. The real deps are covered by the
 * knowledge store + memory-scope suites.
 */
import { describe, expect, test } from "bun:test";
import { retrieveChatContext, type RetrieveDeps } from "./retrieve";
import type { SearchHit } from "../knowledge/store";
import type { ScopedRecall } from "../memory/team-memory";

const INPUT = {
  orgId: "org-1",
  userId: "alice",
  query: "how do we deploy",
  memoryScope: "org" as const,
  threadId: "chat:org-1",
};

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    rank: 1,
    text: "Deploys go through the release workflow.",
    citation: "connector#ext-1",
    id: "k1",
    kind: "insight",
    title: "Deploy process",
    ...over,
  };
}

function recall(items: ScopedRecall["items"]): ScopedRecall {
  return { rendered: "irrelevant", items, truncated: false, latencyMs: 1, degraded: false };
}

function memItem(content: string) {
  return {
    kind: "memory" as const,
    content,
    sourceScope: "org" as const,
    citation: { provider: "tencent-memorycore" as const, assetId: "m1" },
    trust: "reference" as const,
  };
}

function deps(over: Partial<RetrieveDeps> = {}): RetrieveDeps {
  return {
    searchKnowledge: async () => [],
    recallMemory: async () => null,
    ...over,
  };
}

describe("retrieveChatContext", () => {
  test("passes the persisted trusted origin to memory retrieval", async () => {
    let observedOrigin: string | null | undefined;
    await retrieveChatContext(
      { ...INPUT, origin: "internal:t3-parity" },
      deps({
        recallMemory: async (input) => {
          observedOrigin = input.origin;
          return null;
        },
      }),
    );
    expect(observedOrigin).toBe("internal:t3-parity");
  });

  test("blank query short-circuits to empty (no dep calls)", async () => {
    let called = false;
    const ctx = await retrieveChatContext(
      { ...INPUT, query: "   " },
      deps({
        searchKnowledge: async () => {
          called = true;
          return [hit()];
        },
      }),
    );
    expect(ctx).toEqual({ block: "", citations: [] });
    expect(called).toBe(false);
  });

  test("nothing found -> empty block, empty citations", async () => {
    const ctx = await retrieveChatContext(INPUT, deps());
    expect(ctx.block).toBe("");
    expect(ctx.citations).toEqual([]);
  });

  test("knowledge + memory merge into one block with combined citations", async () => {
    const ctx = await retrieveChatContext(
      INPUT,
      deps({
        searchKnowledge: async () => [hit()],
        recallMemory: async () => recall([memItem("The team prefers blue-green deploys.")]),
      }),
    );
    expect(ctx.block).toContain("Org knowledge:");
    expect(ctx.block).toContain("Deploy process");
    expect(ctx.block).toContain("Team memory:");
    expect(ctx.block).toContain("blue-green");
    // reference framing (not instructions)
    expect(ctx.block).toContain("not instructions");
    expect(ctx.citations).toEqual([
      { title: "Deploy process", source: "knowledge" },
      { title: "The team prefers blue-green deploys.", source: "memory" },
    ]);
  });

  test("wiki-kind hit is tagged wiki; an http citation becomes a url", async () => {
    const ctx = await retrieveChatContext(
      INPUT,
      deps({
        searchKnowledge: async () => [
          hit({ kind: "wiki", title: "Architecture", citation: "https://wiki.example/arch" }),
        ],
      }),
    );
    expect(ctx.citations[0]).toEqual({
      title: "Architecture",
      url: "https://wiki.example/arch",
      source: "wiki",
    });
  });

  test("best-effort: a throwing dep degrades to empty, the other still contributes", async () => {
    const ctx = await retrieveChatContext(
      INPUT,
      deps({
        searchKnowledge: async () => {
          throw new Error("db down");
        },
        recallMemory: async () => recall([memItem("Memory still works.")]),
      }),
    );
    expect(ctx.block).toContain("Team memory:");
    expect(ctx.block).not.toContain("Org knowledge:");
    expect(ctx.citations).toEqual([{ title: "Memory still works.", source: "memory" }]);
  });

  test("disabled memory (null recall) yields knowledge only, no fake memory", async () => {
    const ctx = await retrieveChatContext(
      INPUT,
      deps({ searchKnowledge: async () => [hit()], recallMemory: async () => null }),
    );
    expect(ctx.block).toContain("Org knowledge:");
    expect(ctx.block).not.toContain("Team memory:");
    expect(ctx.citations).toHaveLength(1);
  });
});
