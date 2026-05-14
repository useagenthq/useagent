// Thread-token memo (perf run-invariant-config slice). A thread-scoped gateway
// capability only makes the sandbox config byte-stable across warm turns if the
// SAME token bytes are reused - re-minting each turn would change the config and
// re-trigger activation. Process-local by design: after a backend restart the
// first warm turn re-mints and re-activates once.
//
// EXPIRY CONTRACT (adversarial-review finding): tokens are verified per REQUEST,
// so a long turn dispatched on an aged token could see it expire MID-TURN. The
// caller therefore mints with ttlMs = turn-cover TTL + reuse window, and passes
// refreshMarginMs = the turn-cover TTL: any token this memo hands out is
// guaranteed at least a full turn-cover TTL of remaining validity - the same
// in-turn guarantee a freshly minted run token gives.

interface MemoizedToken {
  readonly token: string;
  readonly exp: number;
}

const MAX_ENTRIES = 5_000;

export class ThreadTokenMemo {
  private readonly entries = new Map<string, MemoizedToken>();

  get(
    key: string,
    opts: { readonly ttlMs: number; readonly refreshMarginMs: number },
    mint: () => string,
    nowMs = Date.now(),
  ): string {
    const { ttlMs, refreshMarginMs } = opts;
    const existing = this.entries.get(key);
    if (existing && nowMs < existing.exp - refreshMarginMs) return existing.token;
    if (this.entries.size >= MAX_ENTRIES) {
      for (const [k, v] of this.entries) {
        if (v.exp <= nowMs) this.entries.delete(k);
      }
      // Still saturated with live entries: drop the oldest insertions rather
      // than grow without bound (a re-mint on those threads is cheap).
      while (this.entries.size >= MAX_ENTRIES) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    const token = mint();
    this.entries.set(key, { token, exp: nowMs + ttlMs });
    return token;
  }

  /** Test seam. */
  clear(): void {
    this.entries.clear();
  }
}
