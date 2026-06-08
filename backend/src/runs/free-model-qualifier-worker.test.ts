import { describe, expect, test } from "bun:test";
import type {
  FreeModelCandidateRow,
  FreeModelRegistryStateRow,
} from "../db/schema";
import type { ClaimedFreeModelCandidate } from "./free-model-registry-repo";
import type { FreeModelQualificationResult } from "./free-model-qualification-driver";
import {
  desiredPublishedLane,
  fetchOpenRouterFreeModelCandidates,
  freeModelQualifierEnabled,
  runFreeModelQualifierTick,
  startFreeModelRegistryHydrator,
  type FreeModelQualifierRepository,
} from "./free-model-qualifier-worker";

const NOW = 1_800_000_000_000;

function candidate(
  modelId: string,
  overrides: Partial<FreeModelCandidateRow> = {},
): FreeModelCandidateRow {
  const now = new Date(NOW);
  return {
    modelId,
    provider: "openrouter",
    source: "test",
    state: "pending",
    advertised: false,
    everQualified: false,
    successStreak: 0,
    failureStreak: 0,
    attemptCount: 0,
    nextProbeAt: now,
    claimToken: null,
    claimExpiresAt: null,
    lastClaimedAt: null,
    lastProbeAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    qualifiedAt: null,
    lastOutcome: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function registryState(currentModelIds: string[]): FreeModelRegistryStateRow {
  const now = new Date(NOW);
  return {
    lane: "opencode_free",
    generation: 1,
    currentModelIds,
    lastGoodModelIds: currentModelIds,
    lastPublishOutcome: "published",
    lastPublishAt: now,
    probeBudgetDay: "2027-01-15",
    dailyProbeBudget: 24,
    probesClaimedToday: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function claim(row: FreeModelCandidateRow): ClaimedFreeModelCandidate {
  return {
    modelId: row.modelId,
    provider: row.provider,
    state: row.state,
    successStreak: row.successStreak,
    failureStreak: row.failureStreak,
    everQualified: row.everQualified,
    claimToken: crypto.randomUUID(),
    claimExpiresAt: new Date(NOW + 60_000),
  };
}

function fakeRepository(input: {
  state: FreeModelRegistryStateRow;
  candidates: FreeModelCandidateRow[];
  claims?: ClaimedFreeModelCandidate[];
}) {
  const claims = [...(input.claims ?? [])];
  const records: Parameters<FreeModelQualifierRepository["recordResult"]>[0][] = [];
  const publishes: Parameters<FreeModelQualifierRepository["publish"]>[0][] = [];
  const repository: FreeModelQualifierRepository = {
    upsertDiscovered: async (discovered) => discovered.length,
    claimDue: async () => claims.splice(0, 1),
    recordResult: async (result) => {
      records.push(result);
      const row = input.candidates.find((item) => item.modelId === result.modelId);
      if (row && result.outcome === "success") {
        row.successStreak += 1;
        row.failureStreak = 0;
        if (row.successStreak >= 2) {
          row.state = "qualified";
          row.everQualified = true;
        }
      } else if (row && result.outcome === "failure") {
        row.failureStreak += 1;
        row.successStreak = 0;
        if (row.failureStreak >= 2) row.state = "disqualified";
      }
      return true;
    },
    loadRegistry: async () => ({ state: input.state, candidates: input.candidates }),
    publish: async (publishInput) => {
      publishes.push(publishInput);
      if (publishInput.systemFailure) {
        return {
          outcome: "preserved_system_failure" as const,
          state: { ...input.state, lastPublishOutcome: "preserved_system_failure" as const },
        };
      }
      if (publishInput.modelIds.length === 0) {
        return {
          outcome: "preserved_empty" as const,
          state: { ...input.state, lastPublishOutcome: "preserved_empty" as const },
        };
      }
      input.state = {
        ...input.state,
        generation: input.state.generation + 1,
        currentModelIds: [...publishInput.modelIds],
        lastGoodModelIds: [...publishInput.modelIds],
      };
      return { outcome: "published" as const, state: input.state };
    },
  };
  return { repository, records, publishes };
}

function discovery(...ids: string[]) {
  return async () => ({
    ok: true as const,
    candidates: ids.map((id, index) => ({ id, contextLength: 200_000 - index })),
  });
}

function driver(result: FreeModelQualificationResult) {
  const requests: string[] = [];
  return {
    requests,
    driver: {
      qualify: async ({ modelId }: { modelId: string }) => {
        requests.push(modelId);
        return result;
      },
    },
  };
}

const openAdmission = async () => ({
  open: true,
  operationId: "test",
  actor: "test",
  reason: "test",
  changedAt: new Date(NOW).toISOString(),
});

describe("free-model qualifier worker", () => {
  test("both rollout switches are default off", () => {
    expect(freeModelQualifierEnabled({})).toBe(false);
    expect(freeModelQualifierEnabled({ FREE_MODEL_QUALIFIER_ENABLED: "0" })).toBe(false);
    expect(freeModelQualifierEnabled({ FREE_MODEL_QUALIFIER_ENABLED: "1" })).toBe(true);
  });

  test("registry hydration is default off and schedules every enabled replica", () => {
    let scheduled: (() => void) | null = null;
    let intervalMs = 0;
    let unrefCalled = false;
    const deps = {
      hydrate: async () => true,
      schedule: (run: () => void, interval: number) => {
        scheduled = run;
        intervalMs = interval;
        return { unref: () => { unrefCalled = true; } };
      },
    };
    expect(startFreeModelRegistryHydrator(deps, {})).toBe(false);
    expect(startFreeModelRegistryHydrator(
      deps,
      { FREE_MODEL_REGISTRY_READ_ENABLED: "1" },
    )).toBe(true);
    expect(scheduled).not.toBeNull();
    expect(intervalMs).toBe(60_000);
    expect(unrefCalled).toBe(true);
  });

  test("catalog fetch classifies provider failures without reading response bodies", async () => {
    await expect(fetchOpenRouterFreeModelCandidates(async () =>
      new Response("secret upstream body", { status: 503 })
    )).resolves.toEqual({
      ok: false,
      errorCode: "provider_capacity",
      httpStatus: 503,
    });
    await expect(fetchOpenRouterFreeModelCandidates(async () =>
      new Response(JSON.stringify({
        data: [{
          id: "vendor/new:free",
          context_length: 100_000,
          supported_parameters: ["tools"],
        }],
      }), { status: 200 })
    )).resolves.toEqual({
      ok: true,
      candidates: [{ id: "vendor/new:free", contextLength: 100_000 }],
    });
  });

  test("does no catalog or agent work while deployment admission is closed", async () => {
    const seed = candidate("seed:free", { state: "qualified", everQualified: true });
    const fake = fakeRepository({ state: registryState([seed.modelId]), candidates: [seed] });
    let discovered = false;
    const agent = driver({
      classification: "success",
      latencyMs: 10,
      httpStatus: 200,
      errorCode: null,
    });
    const result = await runFreeModelQualifierTick({
      driver: agent.driver,
      repository: fake.repository,
      admission: async () => ({
        open: false,
        operationId: "deploy",
        actor: "release",
        reason: "deployment",
        changedAt: new Date().toISOString(),
      }),
      discover: async () => {
        discovered = true;
        return { ok: false, errorCode: "unknown", httpStatus: null };
      },
    });
    expect(result.status).toBe("skipped_admission_closed");
    expect(discovered).toBe(false);
    expect(agent.requests).toEqual([]);
    expect(fake.publishes).toEqual([]);
  });

  test("promotes a repeatably successful discovered model and publishes atomically", async () => {
    const seed = candidate("seed:free", {
      state: "qualified",
      everQualified: true,
      advertised: true,
      successStreak: 2,
    });
    const fresh = candidate("vendor/fresh:free", { successStreak: 1 });
    const fake = fakeRepository({
      state: registryState([seed.modelId]),
      candidates: [seed, fresh],
      claims: [claim(fresh)],
    });
    const agent = driver({
      classification: "success",
      latencyMs: 12,
      httpStatus: 200,
      errorCode: null,
    });
    const adopted: string[][] = [];
    const result = await runFreeModelQualifierTick({
      driver: agent.driver,
      repository: fake.repository,
      admission: openAdmission,
      discover: discovery(seed.modelId, fresh.modelId),
      nowMs: () => NOW,
      adoptPublishedLane: (state) => adopted.push(state.currentModelIds),
    });
    expect(result).toMatchObject({
      status: "completed",
      claimed: 1,
      recorded: 1,
      publishOutcome: "published",
    });
    expect(agent.requests).toEqual([fresh.modelId]);
    expect(fake.records[0]).toMatchObject({ outcome: "success", errorCode: null });
    expect(fake.publishes).toEqual([{ modelIds: [seed.modelId, fresh.modelId] }]);
    expect(adopted).toEqual([[seed.modelId, fresh.modelId]]);
  });

  test("one partial catalog response cannot evict a currently qualified model", () => {
    const first = candidate("vendor/current-a:free", {
      state: "qualified",
      everQualified: true,
    });
    const temporarilyMissing = candidate("vendor/current-b:free", {
      state: "qualified",
      everQualified: true,
    });
    expect(desiredPublishedLane(
      {
        state: registryState([first.modelId, temporarilyMissing.modelId]),
        candidates: [first, temporarilyMissing],
      },
      [{ id: first.modelId, contextLength: 100_000 }],
    )).toEqual([first.modelId, temporarilyMissing.modelId]);
  });

  test("account-wide failure stops the batch and preserves last-good", async () => {
    const first = candidate("vendor/first:free");
    const second = candidate("vendor/second:free");
    const fake = fakeRepository({
      state: registryState(["seed:free"]),
      candidates: [first, second],
      claims: [claim(first), claim(second)],
    });
    const agent = driver({
      classification: "system_failure",
      latencyMs: 20,
      httpStatus: 401,
      errorCode: "authentication_failed",
    });
    const result = await runFreeModelQualifierTick({
      driver: agent.driver,
      repository: fake.repository,
      admission: openAdmission,
      discover: discovery(first.modelId, second.modelId),
      nowMs: () => NOW,
      maxProbes: 4,
    });
    expect(agent.requests).toEqual([first.modelId]);
    expect(fake.records[0]).toMatchObject({ outcome: "system_failure" });
    expect(fake.publishes).toEqual([{ modelIds: [], systemFailure: true }]);
    expect(result).toMatchObject({
      systemFailure: true,
      claimed: 1,
      publishOutcome: "preserved_system_failure",
    });
  });

  test("second model failure quarantines but an empty result preserves last-good", async () => {
    const failing = candidate("vendor/failing:free", {
      state: "qualified",
      everQualified: true,
      advertised: true,
      failureStreak: 1,
    });
    const fake = fakeRepository({
      state: registryState([failing.modelId]),
      candidates: [failing],
      claims: [claim(failing)],
    });
    const agent = driver({
      classification: "model_failure",
      latencyMs: 30,
      httpStatus: 403,
      errorCode: "hosted_app_restricted",
    });
    const result = await runFreeModelQualifierTick({
      driver: agent.driver,
      repository: fake.repository,
      admission: openAdmission,
      discover: discovery(failing.modelId),
      nowMs: () => NOW,
    });
    expect(failing.state).toBe("disqualified");
    expect(fake.records[0]?.nextProbeAt.getTime()).toBe(NOW + 60 * 60_000);
    expect(fake.publishes).toEqual([{ modelIds: [] }]);
    expect(result.publishOutcome).toBe("preserved_empty");
    await expect(fake.repository.loadRegistry()).resolves.toMatchObject({
      state: { currentModelIds: [failing.modelId] },
    });
  });

  test("catalog-wide failure never starts an agent and preserves the lane", async () => {
    const fake = fakeRepository({ state: registryState(["seed:free"]), candidates: [] });
    const agent = driver({
      classification: "success",
      latencyMs: 1,
      httpStatus: 200,
      errorCode: null,
    });
    const result = await runFreeModelQualifierTick({
      driver: agent.driver,
      repository: fake.repository,
      admission: openAdmission,
      discover: async () => ({
        ok: false,
        errorCode: "provider_capacity",
        httpStatus: 503,
      }),
    });
    expect(agent.requests).toEqual([]);
    expect(fake.publishes).toEqual([{ modelIds: [], systemFailure: true }]);
    expect(result.status).toBe("catalog_failure");
  });
});
