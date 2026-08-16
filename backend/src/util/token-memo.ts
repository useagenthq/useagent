// Thread-token memo (perf run-invariant-config slice). A thread-scoped gateway
// capability only makes the sandbox config byte-stable across warm turns if the
// SAME token bytes are reused - re-minting each turn would change the config and
// re-trigger activation. Process-local by design: after a backend restart the
// first warm turn re-mints and re-activates once.
//
// EXPIRY CONTRACT: ttlMs is the complete signed-token lifetime, never a base to
// which reuse time is added. Callers reserve a refresh margin inside that TTL so
// warm turns can reuse identical bytes without extending the configured ceiling.

interface MemoizedToken {
  readonly token: string;
  readonly exp: number;
  readonly ttlMs: number;
}

const MAX_ENTRIES = 5_000;

export const THREAD_TOKEN_REUSE_WINDOW_MS = 15 * 60 * 1000;

export function threadTokenMemoOptions(
  ttlMs: number,
  reuseWindowMs: number,
): { readonly ttlMs: number; readonly refreshMarginMs: number } {
  // Short custom TTLs still get useful warm reuse while retaining at least half
  // their lifetime for the turn that receives an aged token.
  const boundedReuseWindowMs = Math.min(reuseWindowMs, ttlMs / 2);
  return { ttlMs, refreshMarginMs: ttlMs - boundedReuseWindowMs };
}

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
    if (
      existing &&
      existing.ttlMs === ttlMs &&
      nowMs < existing.exp - refreshMarginMs
    ) {
      return existing.token;
    }
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
    this.entries.set(key, { token, exp: nowMs + ttlMs, ttlMs });
    return token;
  }

  /** Test seam. */
  clear(): void {
    this.entries.clear();
  }
}
