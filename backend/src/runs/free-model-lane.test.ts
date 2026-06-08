import { afterEach, describe, expect, test } from "bun:test";
import {
  deriveFreeModelLane,
  discoverOpenRouterFreeModels,
  FREE_MODEL_LANE_SEED,
  FreeModelLaneCache,
  freeModelLaneCache,
  freeModelRegistryReadEnabled,
  refreshFreeModelLane,
  setFreeModelCatalogFetcherForTest,
  type CatalogFetcher,
} from "./free-model-lane";
import { allowedModelsForEngine, isModelAllowedForEngine } from "./model-policy";
import { engineModelsForReadyEngines } from "./engine-readiness";

function entry(id: string, contextLength: number, params: string[] = ["tools", "temperature"]) {
  return { id, context_length: contextLength, supported_parameters: params };
}

function catalogResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const FRESH_MODEL = "dots-studio/dots-3-note-preview:free";

/** Counting fixture fetcher. */
function fetcherOf(respond: () => Response | Promise<Response>): {
  fetcher: CatalogFetcher;
  calls: () => number;
} {
  let calls = 0;
  return {
    fetcher: async () => {
      calls += 1;
      return respond();
    },
    calls: () => calls,
  };
}

describe("deriveFreeModelLane (catalog filter)", () => {
  test("discovers unproven tool-capable free models without advertising them", () => {
    const catalog = {
      data: [
        entry("vendor/new-agent:free", 200_000),
        entry("vendor/no-tools:free", 200_000, ["temperature"]),
        entry("vendor/paid", 200_000),
      ],
    };
    expect(discoverOpenRouterFreeModels(catalog)).toEqual([
      { id: "vendor/new-agent:free", contextLength: 200_000 },
    ]);
    expect(deriveFreeModelLane(catalog)).toEqual([]);
  });

  test("keeps hosted-proven tool-capable free ids with usable context, largest first", () => {
    const lane = deriveFreeModelLane({
      data: [
        entry("minimax/minimax-m3:free", 1_048_576),
        entry("dots-studio/dots-3-note-preview:free", 512_000),
        entry("nvidia/nemotron-3-super-120b-a12b:free", 262_144),
        entry("nvidia/nemotron-3-ultra-550b-a55b:free", 1_000_000),
        entry("vendor/unproven:free", 2_000_000),
        entry("vendor/paid-model", 200_000), // not :free
        entry("vendor/no-tools:free", 200_000, ["temperature"]), // no tool calls
        entry("vendor/tiny-context:free", 32_000), // below the context floor
        { id: "vendor/string-context:free", context_length: "big", supported_parameters: ["tools"] },
        { context_length: 100_000, supported_parameters: ["tools"] }, // missing id
        null,
        "garbage",
      ],
    });
    expect(lane).toEqual([
      "minimax/minimax-m3:free",
      "dots-studio/dots-3-note-preview:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
    ]);
  });

  test("returns [] for empty or malformed payloads", () => {
    expect(deriveFreeModelLane({ data: [] })).toEqual([]);
    expect(deriveFreeModelLane({})).toEqual([]);
    expect(deriveFreeModelLane({ data: "nope" })).toEqual([]);
    expect(deriveFreeModelLane([])).toEqual([]);
    expect(deriveFreeModelLane(null)).toEqual([]);
    expect(deriveFreeModelLane("html error page")).toEqual([]);
  });

  test("excludes catalog-visible models without hosted agent-path proof", () => {
    expect(deriveFreeModelLane({
      data: [
        entry("thinkingmachines/inkling:free", 1_048_576),
        entry("thinkingmachines/inkling-small:free", 1_048_576),
      ],
    })).toEqual([]);
  });

  test("legacy default-off filtering cannot lose a hosted model ranked after discovery cap", () => {
    const higherContextUnverified = Array.from({ length: 100 }, (_, index) =>
      entry(`vendor/unverified-${index}:free`, 2_000_000 - index)
    );
    expect(deriveFreeModelLane({
      data: [
        ...higherContextUnverified,
        entry("minimax/minimax-m3:free", 100_000),
      ],
    })).toEqual(["minimax/minimax-m3:free"]);
  });
});

describe("FreeModelLaneCache", () => {
  const FRESH = { data: [entry(FRESH_MODEL, 1_000_000)] };

  test("boots on the curated seed and swaps to a fetched lane", async () => {
    const cache = new FreeModelLaneCache();
    expect(cache.lane()).toEqual([...FREE_MODEL_LANE_SEED]);

    const { fetcher } = fetcherOf(() => catalogResponse(FRESH));
    await cache.refresh({ fetcher, nowMs: 1_000 });
    expect(cache.lane()).toEqual([FRESH_MODEL]);
    // Acceptance is seed UNION lane: rotation never strands a selection.
    expect(cache.isAllowed(FRESH_MODEL)).toBe(true);
    expect(cache.isAllowed(FREE_MODEL_LANE_SEED[0])).toBe(true);
    expect(cache.isAllowed("vendor/unknown:free")).toBe(false);
  });

  test("keeps the DB-published lane isolated until the read switch selects it", () => {
    const cache = new FreeModelLaneCache();
    expect(cache.adoptRegistryLane(["vendor/qualified:free"])).toBe(true);
    expect(cache.lane()).toEqual([...FREE_MODEL_LANE_SEED]);
    expect(cache.lane(true)).toEqual(["vendor/qualified:free"]);
    expect(cache.isAllowed(FREE_MODEL_LANE_SEED[0])).toBe(true);
    expect(cache.isAllowed(FREE_MODEL_LANE_SEED[0], true)).toBe(false);
    expect(cache.isAllowed("vendor/qualified:free", true)).toBe(true);
    expect(cache.adoptRegistryLane([])).toBe(false);
    expect(cache.lane(true)).toEqual(["vendor/qualified:free"]);
    expect(cache.adoptRegistryLane([], { allowEmpty: true })).toBe(true);
    expect(cache.lane(true)).toEqual([]);
  });

  test("failed, non-ok, or empty catalog responses keep the last-good lane", async () => {
    const cache = new FreeModelLaneCache({ ttlMs: 10, retryMs: 10 });
    const throwing: CatalogFetcher = async () => {
      throw new Error("network down");
    };
    await cache.refresh({ fetcher: throwing, nowMs: 1_000 });
    expect(cache.lane()).toEqual([...FREE_MODEL_LANE_SEED]);

    const { fetcher: ok } = fetcherOf(() => catalogResponse(FRESH));
    await cache.refresh({ fetcher: ok, nowMs: 2_000 });
    expect(cache.lane()).toEqual([FRESH_MODEL]);

    const { fetcher: notOk } = fetcherOf(() => new Response(null, { status: 503 }));
    await cache.refresh({ fetcher: notOk, nowMs: 3_000 });
    expect(cache.lane()).toEqual([FRESH_MODEL]);

    const { fetcher: empty } = fetcherOf(() => catalogResponse({ data: [] }));
    await cache.refresh({ fetcher: empty, nowMs: 4_000 });
    expect(cache.lane()).toEqual([FRESH_MODEL]);

    const { fetcher: garbage } = fetcherOf(
      () => new Response("<html>rate limited</html>", { status: 200 }),
    );
    await cache.refresh({ fetcher: garbage, nowMs: 5_000 });
    expect(cache.lane()).toEqual([FRESH_MODEL]);
  });

  test("catalog rotation never invalidates a model accepted earlier in this process", async () => {
    const cache = new FreeModelLaneCache({ ttlMs: 1 });
    const firstModel = "minimax/minimax-m3:free";
    const secondModel = "dots-studio/dots-3-note-preview:free";
    const first = fetcherOf(() =>
      catalogResponse({ data: [entry(firstModel, 1_000_000)] }),
    );
    const second = fetcherOf(() =>
      catalogResponse({ data: [entry(secondModel, 512_000)] }),
    );

    await cache.refresh({ fetcher: first.fetcher, nowMs: 1_000 });
    await cache.refresh({ fetcher: second.fetcher, nowMs: 2_000 });

    expect(cache.lane()).toEqual([secondModel]);
    expect(cache.isAllowed(firstModel)).toBe(true);
    expect(cache.isAllowed(secondModel)).toBe(true);
  });

  test("TTL gates background refreshes; expiry admits exactly one", async () => {
    const cache = new FreeModelLaneCache({ ttlMs: 500 });
    const { fetcher, calls } = fetcherOf(() => catalogResponse(FRESH));

    await cache.refresh({ fetcher, nowMs: 1_000 });
    expect(calls()).toBe(1);
    await cache.refresh({ fetcher, nowMs: 1_400 }); // inside TTL
    expect(calls()).toBe(1);
    await cache.refresh({ fetcher, nowMs: 1_600 }); // expired
    expect(calls()).toBe(2);
  });

  test("a failed attempt cools down before the next automatic retry", async () => {
    const cache = new FreeModelLaneCache({ ttlMs: 5, retryMs: 300 });
    const { fetcher, calls } = fetcherOf(() => new Response(null, { status: 500 }));

    await cache.refresh({ fetcher, nowMs: 1_000 });
    expect(calls()).toBe(1);
    await cache.refresh({ fetcher, nowMs: 1_100 }); // still cooling
    expect(calls()).toBe(1);
    await cache.refresh({ fetcher, nowMs: 1_400 }); // cool-down elapsed
    expect(calls()).toBe(2);
  });

  test("concurrent refreshes single-flight into one catalog fetch", async () => {
    const cache = new FreeModelLaneCache();
    const gate = Promise.withResolvers<Response>();
    let calls = 0;
    const fetcher: CatalogFetcher = () => {
      calls += 1;
      return gate.promise;
    };

    const first = cache.refresh({ fetcher, nowMs: 1_000 });
    const second = cache.refresh({ fetcher, nowMs: 1_001 });
    expect(second).toBe(first);
    expect(calls).toBe(1);

    gate.resolve(catalogResponse(FRESH));
    await Promise.all([first, second]);
    expect(cache.lane()).toEqual([FRESH_MODEL]);
  });

  test("forceRefresh busts the TTL but is cool-down rate-limited and single-flight", async () => {
    const cache = new FreeModelLaneCache({ ttlMs: 1_000_000, forceCooldownMs: 30_000 });
    const { fetcher, calls } = fetcherOf(() => catalogResponse(FRESH));

    // Fresh TTL would block a background refresh; force goes through.
    await cache.refresh({ fetcher, nowMs: 1_000 });
    expect(calls()).toBe(1);
    const forced = cache.forceRefresh({ fetcher, nowMs: 2_000 });
    expect(forced.admitted).toBe(true);
    await forced.done;
    expect(calls()).toBe(2);

    // Inside the manual cool-down: rejected with a retry hint, no fetch.
    const limited = cache.forceRefresh({ fetcher, nowMs: 10_000 });
    expect(limited.admitted).toBe(false);
    expect(limited.retryAfterMs).toBe(22_000);
    await limited.done;
    expect(calls()).toBe(2);

    // After the cool-down: admitted again.
    const later = cache.forceRefresh({ fetcher, nowMs: 40_000 });
    expect(later.admitted).toBe(true);
    await later.done;
    expect(calls()).toBe(3);

    // A first manual request may JOIN an automatic in-flight refresh, but it
    // still starts the manual cool-down so an immediate repeat cannot stack.
    const gate = Promise.withResolvers<Response>();
    let gatedCalls = 0;
    const gated: CatalogFetcher = () => {
      gatedCalls += 1;
      return gate.promise;
    };
    const automatic = cache.refresh({ fetcher: gated, nowMs: 100_000 });
    const joined = cache.forceRefresh({ fetcher: gated, nowMs: 100_001 });
    const repeated = cache.forceRefresh({ fetcher: gated, nowMs: 100_002 });
    expect(joined.admitted).toBe(true);
    expect(repeated.admitted).toBe(false);
    expect(gatedCalls).toBe(1);
    gate.resolve(catalogResponse(FRESH));
    await Promise.all([automatic, joined.done]);

    const afterJoin = cache.forceRefresh({ fetcher: gated, nowMs: 100_003 });
    expect(afterJoin.admitted).toBe(false);
    expect(afterJoin.retryAfterMs).toBe(29_998);
  });
});

test("registry reads are explicitly default off", () => {
  expect(freeModelRegistryReadEnabled({})).toBe(false);
  expect(freeModelRegistryReadEnabled({ FREE_MODEL_REGISTRY_READ_ENABLED: "0" })).toBe(false);
  expect(freeModelRegistryReadEnabled({ FREE_MODEL_REGISTRY_READ_ENABLED: "1" })).toBe(true);
});

describe("dynamic lane -> policy and manifest integration", () => {
  afterEach(() => {
    // Restore the networkless preload stub + cold seed state for other suites.
    setFreeModelCatalogFetcherForTest(async () => new Response(null, { status: 503 }));
    freeModelLaneCache.reset();
  });

  test("a refreshed lane is accepted by policy and advertised by the manifest", async () => {
    // Cold-start the shared cache: an earlier suite's /api/config kick against
    // the networkless preload stub leaves a failure cool-down that would gate
    // this background refresh.
    freeModelLaneCache.reset();
    setFreeModelCatalogFetcherForTest(async () =>
      catalogResponse({ data: [entry(FRESH_MODEL, 1_000_000)] }),
    );
    await refreshFreeModelLane();

    expect(allowedModelsForEngine("opencode", {})).toContain(FRESH_MODEL);
    expect(isModelAllowedForEngine("opencode", FRESH_MODEL)).toBe(true);
    // Seed models stay accepted after a rotation (in-flight selections survive)...
    expect(isModelAllowedForEngine("opencode", FREE_MODEL_LANE_SEED[0])).toBe(true);
    // ...but only the current lane is advertised.
    expect(allowedModelsForEngine("opencode", {})).not.toContain(FREE_MODEL_LANE_SEED[0]);
    // The lane stays OpenCode-only.
    expect(isModelAllowedForEngine("pi", FRESH_MODEL)).toBe(false);

    const models = engineModelsForReadyEngines({
      NODE_ENV: "production",
      USEAGENT_DEV_MODE: "false",
      ENGINE_READINESS_OPENCODE: "verified",
      PROVIDER_HEALTH_ANTHROPIC: "verified",
      PROVIDER_HEALTH_OPENAI: "verified",
      PROVIDER_HEALTH_OPENROUTER: "verified",
    });
    expect(models.opencode).toContain(FRESH_MODEL);
  });
});
