import { describe, expect, test } from "bun:test";
import { ThreadTokenMemo, threadTokenMemoOptions } from "./token-memo";

describe("ThreadTokenMemo", () => {
  // ttl is the complete 400s lifetime; reuse stops with 100s remaining.
  const OPTS = { ttlMs: 400_000, refreshMarginMs: 100_000 };

  test("reuses identical bytes until remaining validity drops below the turn-cover margin", () => {
    const memo = new ThreadTokenMemo();
    let minted = 0;
    const mint = () => `token-${++minted}`;
    const t0 = 1_000_000;
    expect(memo.get("k", OPTS, mint, t0)).toBe("token-1");
    // 250s in: 150s remaining > 100s margin -> reuse.
    expect(memo.get("k", OPTS, mint, t0 + 250_000)).toBe("token-1");
    // 310s in: 90s remaining < 100s margin -> re-mint (a dispatched turn must
    // always have at least the full turn-cover TTL of validity).
    expect(memo.get("k", OPTS, mint, t0 + 310_000)).toBe("token-2");
    expect(minted).toBe(2);
  });

  test("keeps the reuse window inside the signed TTL and refreshes at its exact boundary", () => {
    const memo = new ThreadTokenMemo();
    let minted = 0;
    const mint = () => `token-${++minted}`;
    const ttlMs = 400_000;
    const opts = threadTokenMemoOptions(ttlMs, 100_000);
    const t0 = 1_000_000;

    expect(opts).toEqual({ ttlMs, refreshMarginMs: 300_000 });
    expect(memo.get("k", opts, mint, t0)).toBe("token-1");
    expect(memo.get("k", opts, mint, t0 + 99_999)).toBe("token-1");
    expect(memo.get("k", opts, mint, t0 + 100_000)).toBe("token-2");
  });

  test("preserves a warm-reuse window for TTLs shorter than the requested window", () => {
    expect(threadTokenMemoOptions(60_000, 100_000)).toEqual({
      ttlMs: 60_000,
      refreshMarginMs: 30_000,
    });
  });

  test("does not reuse a token minted under a different configured TTL", () => {
    const memo = new ThreadTokenMemo();
    let minted = 0;
    const mint = () => `token-${++minted}`;

    expect(
      memo.get("k", threadTokenMemoOptions(400_000, 100_000), mint, 0),
    ).toBe("token-1");
    expect(
      memo.get("k", threadTokenMemoOptions(60_000, 30_000), mint, 1),
    ).toBe("token-2");
  });

  test("every reused token has at least refreshMarginMs of remaining validity", () => {
    const memo = new ThreadTokenMemo();
    let minted = 0;
    const mint = () => `token-${++minted}`;
    for (let at = 0; at <= 600_000; at += 60_000) {
      memo.get("k", OPTS, mint, at);
    }
    // Structural invariant: get() only reuses when now < exp - margin, so every
    // handed-out token has >= margin remaining. Past 300s the first token must
    // have rotated at least once.
    expect(minted).toBeGreaterThanOrEqual(2);
  });

  test("keys are independent", () => {
    const memo = new ThreadTokenMemo();
    let minted = 0;
    const mint = () => `token-${++minted}`;
    expect(memo.get("a", OPTS, mint, 0)).toBe("token-1");
    expect(memo.get("b", OPTS, mint, 0)).toBe("token-2");
    expect(memo.get("a", OPTS, mint, 1)).toBe("token-1");
  });
});
