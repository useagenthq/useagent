/**
 * The Free model lane: zero-cost OpenRouter ":free" variants, derived from the
 * PUBLIC model catalog (no API key required) at runtime so hosted-proven free
 * models track current availability. Policy reads stay synchronous - they serve
 * the last-good lane (or the curated seed) from process memory - while a
 * TTL-gated, single-flight refresh updates it in the background. A failed,
 * empty, or malformed catalog fetch NEVER shrinks the lane and never throws to
 * a caller.
 */

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TIMEOUT_MS = 10_000;
/** Serve a fetched lane for an hour before consulting the catalog again. */
const LANE_TTL_MS = 60 * 60 * 1000;
/** After a failed fetch, wait before retrying so a catalog outage is not
 * amplified by manifest traffic. */
const FAILED_FETCH_RETRY_MS = 60 * 1000;
/** Manual (user-initiated) refresh cool-down. Process-global, which is at
 * least as strict as a per-org bound: the catalog is org-independent, so one
 * refresh serves every org. */
const FORCE_REFRESH_COOLDOWN_MS = 30 * 1000;
const LANE_CAP = 8;
const MIN_CONTEXT_LENGTH = 65_536;
// Admission requires both public-catalog eligibility and a successful hosted
// agent-path probe. OpenRouter metadata alone does not expose app restrictions
// or immediate free-tier throttling, so unproven new entries never auto-ship.
export const HOSTED_VERIFIED_FREE_MODELS = [
  "minimax/minimax-m3:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "inclusionai/ling-3.0-flash-fin:free",
] as const;
const HOSTED_VERIFIED_FREE_MODEL_SET = new Set<string>(HOSTED_VERIFIED_FREE_MODELS);

/** Curated fallback lane (verified tool-capable free models): the boot state
 * and the safety net whenever the live catalog is unreachable or garbage. */
export const FREE_MODEL_LANE_SEED = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "minimax/minimax-m3:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "inclusionai/ling-3.0-flash-fin:free",
] as const;

/** Minimal fetch seam so tests inject a fixture catalog (never live network). */
export type CatalogFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface FreeModelLaneRefreshDeps {
  readonly fetcher?: CatalogFetcher;
  readonly nowMs?: number;
}

export interface ForceRefreshResult {
  /** False = rejected by the manual-refresh cool-down (rate limit). */
  readonly admitted: boolean;
  readonly retryAfterMs: number;
  /** Settles when the admitted (or joined in-flight) refresh completes. */
  readonly done: Promise<FreeModelLaneRefreshOutcome>;
}

export interface FreeModelLaneRefreshOutcome {
  readonly updated: boolean;
  readonly stale: boolean;
  readonly reason: "updated" | "fresh" | "http_error" | "invalid_catalog" | "request_failed";
  readonly lane: readonly string[];
}

/**
 * Pure catalog filter: OpenRouter's `/models` payload -> the advertised lane.
 * Keeps ":free" ids that support tool calls (OpenCode always submits agent
 * tools) with a usable context window, prefers larger context, and caps the
 * lane. Returns [] for empty or malformed payloads - the cache treats that as
 * a failed fetch and keeps its last-good lane.
 */
export function deriveFreeModelLane(catalog: unknown): string[] {
  const data =
    catalog && typeof catalog === "object" && !Array.isArray(catalog)
      ? (catalog as { data?: unknown }).data
      : null;
  if (!Array.isArray(data)) return [];
  const candidates: { id: string; contextLength: number }[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as {
      id?: unknown;
      context_length?: unknown;
      supported_parameters?: unknown;
    };
    if (typeof entry.id !== "string" || !entry.id.endsWith(":free")) continue;
    if (!HOSTED_VERIFIED_FREE_MODEL_SET.has(entry.id)) continue;
    if (
      typeof entry.context_length !== "number" ||
      entry.context_length < MIN_CONTEXT_LENGTH
    ) {
      continue;
    }
    if (
      !Array.isArray(entry.supported_parameters) ||
      !entry.supported_parameters.includes("tools")
    ) {
      continue;
    }
    candidates.push({ id: entry.id, contextLength: entry.context_length });
  }
  return candidates
    .toSorted((a, b) => b.contextLength - a.contextLength)
    .slice(0, LANE_CAP)
    .map((candidate) => candidate.id);
}

export class FreeModelLaneCache {
  #lane: readonly string[] = FREE_MODEL_LANE_SEED;
  #allowed = new Set<string>(FREE_MODEL_LANE_SEED);
  #fetchedAt = 0;
  #failedAt = 0;
  #forcedAt = 0;
  #inflight: Promise<FreeModelLaneRefreshOutcome> | null = null;
  #fetcher: CatalogFetcher | null;
  readonly #ttlMs: number;
  readonly #retryMs: number;
  readonly #forceCooldownMs: number;

  constructor(
    options: {
      ttlMs?: number;
      retryMs?: number;
      forceCooldownMs?: number;
      fetcher?: CatalogFetcher;
    } = {},
  ) {
    this.#ttlMs = options.ttlMs ?? LANE_TTL_MS;
    this.#retryMs = options.retryMs ?? FAILED_FETCH_RETRY_MS;
    this.#forceCooldownMs = options.forceCooldownMs ?? FORCE_REFRESH_COOLDOWN_MS;
    this.#fetcher = options.fetcher ?? null;
  }

  /** The advertised lane: last-good catalog result, or the seed. */
  lane(): readonly string[] {
    return this.#lane;
  }

  /** Acceptance = seed UNION current lane: a run keeps its selected free model
   * across a lane rotation, and the curated seed never regresses. */
  isAllowed(model: string): boolean {
    return this.#allowed.has(model);
  }

  /** TTL-gated background refresh (stale-while-revalidate): single-flight,
   * failure-cooled, never rejects. Reads keep serving the current lane. */
  refresh(deps: FreeModelLaneRefreshDeps = {}): Promise<FreeModelLaneRefreshOutcome> {
    if (this.#inflight) return this.#inflight;
    const now = deps.nowMs ?? Date.now();
    if (this.#fetchedAt > 0 && now - this.#fetchedAt < this.#ttlMs) {
      return Promise.resolve({ updated: false, stale: false, reason: "fresh", lane: this.#lane });
    }
    if (this.#failedAt > 0 && now - this.#failedAt < this.#retryMs) {
      return Promise.resolve({ updated: false, stale: true, reason: "fresh", lane: this.#lane });
    }
    return this.#start(now, deps.fetcher);
  }

  /** Manual refresh: busts the TTL (and any failure cool-down) but keeps
   * single-flight and the manual cool-down so OpenRouter is protected. */
  forceRefresh(deps: FreeModelLaneRefreshDeps = {}): ForceRefreshResult {
    const now = deps.nowMs ?? Date.now();
    const sinceForce = now - this.#forcedAt;
    if (this.#forcedAt > 0 && sinceForce < this.#forceCooldownMs) {
      return {
        admitted: false,
        retryAfterMs: this.#forceCooldownMs - sinceForce,
        done: Promise.resolve({
          updated: false,
          stale: false,
          reason: "fresh",
          lane: this.#lane,
        }),
      };
    }
    this.#forcedAt = now;
    if (this.#inflight) {
      return { admitted: true, retryAfterMs: 0, done: this.#inflight };
    }
    return { admitted: true, retryAfterMs: 0, done: this.#start(now, deps.fetcher) };
  }

  #start(
    now: number,
    fetcher = this.#fetcher ?? (fetch as CatalogFetcher),
  ): Promise<FreeModelLaneRefreshOutcome> {
    this.#inflight = (async () => {
      let lane: string[] = [];
      let reason: FreeModelLaneRefreshOutcome["reason"] = "request_failed";
      try {
        const response = await fetcher(CATALOG_URL, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
        });
        if (response.ok) {
          lane = deriveFreeModelLane(await response.json());
          reason = lane.length > 0 ? "updated" : "invalid_catalog";
        } else {
          reason = "http_error";
        }
      } catch {
        reason = "request_failed";
      }
      if (lane.length > 0) {
        this.#lane = lane;
        for (const model of lane) this.#allowed.add(model);
        this.#fetchedAt = now;
        this.#failedAt = 0;
      } else {
        this.#failedAt = now;
        console.warn(`[free-model-lane] refresh failed reason=${reason}; serving stale lane`);
      }
      this.#inflight = null;
      return {
        updated: lane.length > 0,
        stale: lane.length === 0,
        reason,
        lane: this.#lane,
      };
    })();
    return this.#inflight;
  }

  /** Test seam: pin the catalog fetcher (tests must never hit live network). */
  setFetcherForTest(fetcher: CatalogFetcher | null): void {
    this.#fetcher = fetcher;
  }

  /** Restore the cold boot state (seed lane). Test isolation seam. */
  reset(): void {
    this.#lane = FREE_MODEL_LANE_SEED;
    this.#allowed.clear();
    for (const model of FREE_MODEL_LANE_SEED) this.#allowed.add(model);
    this.#fetchedAt = 0;
    this.#failedAt = 0;
    this.#forcedAt = 0;
    this.#inflight = null;
  }
}

/** The process-wide cache behind model policy and the /api/config manifest. */
export const freeModelLaneCache = new FreeModelLaneCache();

export function freeModelLane(): readonly string[] {
  return freeModelLaneCache.lane();
}

export function isAllowedFreeModel(model: string): boolean {
  return freeModelLaneCache.isAllowed(model);
}

export function refreshFreeModelLane(
  deps?: FreeModelLaneRefreshDeps,
): Promise<FreeModelLaneRefreshOutcome> {
  return freeModelLaneCache.refresh(deps);
}

export function forceRefreshFreeModelLane(
  deps?: FreeModelLaneRefreshDeps,
): ForceRefreshResult {
  return freeModelLaneCache.forceRefresh(deps);
}

/** Test seam for the SHARED cache (see test/preload.ts). */
export function setFreeModelCatalogFetcherForTest(fetcher: CatalogFetcher | null): void {
  freeModelLaneCache.setFetcherForTest(fetcher);
}
