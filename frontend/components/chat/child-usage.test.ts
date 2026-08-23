import { describe, expect, test } from "bun:test";
import { mergeChildUsage, normalizeChildUsage } from "./child-usage";

describe("child usage cost propagation", () => {
  test("normalizes and max-merges provider-reported costUsd", () => {
    const first = normalizeChildUsage({ totalTokens: 12, costUsd: 0.02 });
    const later = normalizeChildUsage({ totalTokens: 20, costUsd: 0.031 });

    expect(first).toEqual({ totalTokens: 12, costUsd: 0.02 });
    expect(mergeChildUsage(first, later)).toEqual({ totalTokens: 20, costUsd: 0.031 });
  });
});
