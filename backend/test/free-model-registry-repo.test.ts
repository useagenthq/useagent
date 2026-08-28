import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import {
  claimDueFreeModelCandidates,
  FREE_MODEL_LANE,
  loadCurrentFreeModelLane,
  loadFreeModelRegistry,
  publishFreeModelLane,
  recordFreeModelProbeResult,
  upsertDiscoveredFreeModelCandidates,
} from "../src/runs/free-model-registry-repo";
import { insertCommandWithRun } from "../src/commands/repo";
import { listRunSummaries } from "../src/runs/repo";

const SEED_MODELS = [
  "minimax/minimax-m3:free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
] as const;
const ADMIN_URL =
  process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const databaseName = `useagent_free_models_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${databaseName}`;

const admin = postgres(ADMIN_URL, { max: 1 });
await admin.unsafe(`create database "${databaseName}"`);
const client = postgres(testUrl.toString(), { max: 2 });
const clientA = postgres(testUrl.toString(), { max: 1 });
const clientB = postgres(testUrl.toString(), { max: 1 });
const testDb = drizzle(client, { schema });
const dbA = drizzle(clientA, { schema });
const dbB = drizzle(clientB, { schema });
await migrate(testDb, { migrationsFolder: `${import.meta.dir}/../drizzle` });

async function resetFixture(): Promise<void> {
  await client.unsafe(`delete from free_model_probe_attempts`);
  await client.unsafe(`
    delete from free_model_candidates
    where model_id not in (
      'minimax/minimax-m3:free',
      'dots-studio/dots-3-note-preview:free',
      'nvidia/nemotron-3-super-120b-a12b:free'
    )`);
  await client.unsafe(`
    update free_model_candidates
    set state = 'qualified', advertised = true, ever_qualified = true,
      success_streak = 2, failure_streak = 0, attempt_count = 0,
      next_probe_at = now(), claim_token = null, claim_expires_at = null,
      last_claimed_at = null, last_probe_at = null, last_success_at = null,
      last_failure_at = null, last_outcome = null, updated_at = now()`);
  await client.unsafe(`
    update free_model_registry_state
    set generation = 1,
      current_model_ids = '["minimax/minimax-m3:free","dots-studio/dots-3-note-preview:free","nvidia/nemotron-3-super-120b-a12b:free"]'::jsonb,
      last_good_model_ids = '["minimax/minimax-m3:free","dots-studio/dots-3-note-preview:free","nvidia/nemotron-3-super-120b-a12b:free"]'::jsonb,
      last_publish_outcome = 'published',
      probe_budget_day = (now() at time zone 'UTC')::date,
      daily_probe_budget = 24, probes_claimed_today = 0,
      updated_at = now()
    where lane = 'opencode_free'`);
}

beforeEach(resetFixture);

afterAll(async () => {
  await Promise.all([client.end(), clientA.end(), clientB.end()]);
  await admin.unsafe(`drop database if exists "${databaseName}"`);
  await admin.end();
});

async function insertCandidate(modelId: string, state = "pending"): Promise<void> {
  await client.unsafe(`
    insert into free_model_candidates (
      model_id, provider, source, state, next_probe_at
    ) values (
      '${modelId}', 'openrouter', 'test', '${state}', now() - interval '1 second'
    )`);
}

async function makeOnlyDue(modelId: string): Promise<void> {
  await client.unsafe(`
    update free_model_candidates
    set next_probe_at = case
      when model_id = '${modelId}' then now() - interval '1 second'
      else now() + interval '1 day'
    end,
    claim_token = null,
    claim_expires_at = null`);
}

describe("free model registry repository", () => {
  test("catalog discovery inserts pending candidates without resetting existing probe state", async () => {
    const modelId = `test/discovery-${crypto.randomUUID()}:free`;
    await expect(upsertDiscoveredFreeModelCandidates([{
      modelId,
      provider: "openrouter",
      source: "openrouter_catalog",
    }], testDb)).resolves.toBe(1);
    await client.unsafe(`
      update free_model_candidates
      set failure_streak = 1, next_probe_at = now() + interval '2 hours'
      where model_id = '${modelId}'`);
    await expect(upsertDiscoveredFreeModelCandidates([{
      modelId,
      provider: "openrouter",
      source: "replacement_must_not_win",
    }], testDb)).resolves.toBe(1);
    const [row] = await client.unsafe(`
      select source, state, failure_streak,
        (next_probe_at > now() + interval '1 hour') as schedule_preserved
      from free_model_candidates where model_id = '${modelId}'`);
    expect(row).toMatchObject({
      source: "openrouter_catalog",
      state: "pending",
      failure_streak: 1,
      schedule_preserved: true,
    });
  });

  test("internal qualification acceptance persists low fleet priority", async () => {
    const runId = `qualification-${crypto.randomUUID()}`;
    const orgId = `qualification-org-${crypto.randomUUID()}`;
    try {
      await insertCommandWithRun({
        commandId: crypto.randomUUID(),
        idempotencyKey: `qualification:${runId}`,
        orgId,
        actorId: null,
        payloadFingerprint: "a".repeat(64),
        payload: "{}",
        origin: "internal:model-qualification",
        priority: -100,
        run: {
          id: runId,
          prompt: "qualify",
          model: SEED_MODELS[0],
          engine: "opencode",
          parentRunId: null,
          threadId: runId,
          repos: [],
          resolvedResources: [],
          memoryScope: "org",
          skillId: null,
          skillVersion: null,
          skillContentHash: null,
          commandName: null,
          commandProvider: null,
          commandSessionId: null,
          commandCatalogRevision: null,
        },
      }, testDb);
      const [row] = await client.unsafe(`
        select r.origin, a.priority
        from runs r join run_admissions a on a.run_id = r.id
        where r.id = '${runId}'`);
      expect(row).toMatchObject({
        origin: "internal:model-qualification",
        priority: -100,
      });
      await expect(listRunSummaries(orgId, { all: true })).resolves.toEqual([]);
    } finally {
      await client.unsafe(`delete from commands where run_id = '${runId}'`);
      await client.unsafe(`delete from runs where id = '${runId}'`);
    }
  });

  test("migration seeds the v0.0.1 last-good lane without fabricated attempts", async () => {
    const snapshot = await loadFreeModelRegistry(FREE_MODEL_LANE, testDb);
    expect(snapshot.state).toMatchObject({
      generation: 1,
      currentModelIds: [...SEED_MODELS],
      lastGoodModelIds: [...SEED_MODELS],
      dailyProbeBudget: 24,
      probesClaimedToday: 0,
    });
    expect(snapshot.candidates).toHaveLength(3);
    expect(snapshot.candidates).toEqual(expect.arrayContaining(
      SEED_MODELS.map((modelId) => expect.objectContaining({
        modelId,
        source: "bootstrap_v0_0_1",
        state: "qualified",
        advertised: true,
        everQualified: true,
        successStreak: 2,
        attemptCount: 0,
      })),
    ));
    const [attempts] = await client.unsafe(`
      select count(*)::int as count from free_model_probe_attempts`);
    expect(Number(attempts?.count)).toBe(0);
  });

  test("two connections claim one due candidate exactly once", async () => {
    const modelId = `test/exactly-once-${crypto.randomUUID()}:free`;
    await insertCandidate(modelId);
    await makeOnlyDue(modelId);

    const [first, second] = await Promise.all([
      claimDueFreeModelCandidates({ limit: 1, leaseMs: 60_000 }, dbA),
      claimDueFreeModelCandidates({ limit: 1, leaseMs: 60_000 }, dbB),
    ]);
    expect([...first, ...second]).toHaveLength(1);
    expect([...first, ...second][0]?.modelId).toBe(modelId);

    const state = await loadCurrentFreeModelLane(FREE_MODEL_LANE, testDb);
    expect(state?.probesClaimedToday).toBe(1);
  });

  test("only one candidate lease is active globally across independent pools", async () => {
    const firstModel = `test/global-owner-a-${crypto.randomUUID()}:free`;
    const secondModel = `test/global-owner-b-${crypto.randomUUID()}:free`;
    await insertCandidate(firstModel);
    await insertCandidate(secondModel);
    await client.unsafe(`
      update free_model_candidates
      set next_probe_at = case
        when model_id in ('${firstModel}', '${secondModel}')
          then now() - interval '1 second'
        else now() + interval '1 day'
      end`);

    const [first, second] = await Promise.all([
      claimDueFreeModelCandidates({ limit: 1, leaseMs: 60_000 }, dbA),
      claimDueFreeModelCandidates({ limit: 1, leaseMs: 60_000 }, dbB),
    ]);
    expect([...first, ...second]).toHaveLength(1);
    const blockedPool = first.length > 0 ? dbB : dbA;
    await expect(claimDueFreeModelCandidates(
      { limit: 1, leaseMs: 60_000 },
      blockedPool,
    )).resolves.toEqual([]);
  });

  test("a recent systemic failure pauses claims durably across replicas", async () => {
    const modelId = `test/system-pause-${crypto.randomUUID()}:free`;
    await insertCandidate(modelId);
    await makeOnlyDue(modelId);
    await client.unsafe(`
      update free_model_registry_state
      set last_publish_outcome = 'preserved_system_failure',
        last_publish_at = now()
      where lane = 'opencode_free'`);

    await expect(claimDueFreeModelCandidates(
      { limit: 1, leaseMs: 60_000 },
      dbA,
    )).resolves.toEqual([]);

    await client.unsafe(`
      update free_model_registry_state
      set last_publish_at = now() - interval '31 minutes'
      where lane = 'opencode_free'`);
    await expect(claimDueFreeModelCandidates(
      { limit: 1, leaseMs: 60_000 },
      dbB,
    )).resolves.toHaveLength(1);
  });

  test("an expired lease is reclaimed and the stale worker cannot write", async () => {
    const modelId = `test/reclaim-${crypto.randomUUID()}:free`;
    await insertCandidate(modelId);
    await makeOnlyDue(modelId);
    const [first] = await claimDueFreeModelCandidates(
      { limit: 1, leaseMs: 60_000 },
      dbA,
    );
    expect(first).toBeDefined();
    if (!first) throw new Error("expected first claim");

    await client.unsafe(`
      update free_model_candidates
      set claim_expires_at = now() - interval '1 second'
      where model_id = '${modelId}'`);
    const [replacement] = await claimDueFreeModelCandidates(
      { limit: 1, leaseMs: 60_000 },
      dbB,
    );
    expect(replacement).toBeDefined();
    if (!replacement) throw new Error("expected replacement claim");
    expect(replacement.claimToken).not.toBe(first.claimToken);

    await expect(recordFreeModelProbeResult({
      modelId,
      claimToken: first.claimToken,
      outcome: "success",
      nextProbeAt: new Date(Date.now() + 60_000),
      httpStatus: 200,
      latencyMs: 25,
    }, dbA)).resolves.toBe(false);
    await expect(recordFreeModelProbeResult({
      modelId,
      claimToken: replacement.claimToken,
      outcome: "success",
      nextProbeAt: new Date(Date.now() + 60_000),
      httpStatus: 200,
      latencyMs: 25,
    }, dbB)).resolves.toBe(true);

    const [row] = await client.unsafe(`
      select attempt_count, success_streak from free_model_candidates
      where model_id = '${modelId}'`);
    expect(Number(row?.attempt_count)).toBe(1);
    expect(Number(row?.success_streak)).toBe(1);
    const [attempts] = await client.unsafe(`
      select count(*)::int as count from free_model_probe_attempts
      where model_id = '${modelId}'`);
    expect(Number(attempts?.count)).toBe(1);
  });

  test("probe transitions require repeatable model evidence and ignore system failures", async () => {
    const modelId = `test/transitions-${crypto.randomUUID()}:free`;
    await insertCandidate(modelId);
    await makeOnlyDue(modelId);

    for (const expectedState of ["pending", "qualified"] as const) {
      const [claim] = await claimDueFreeModelCandidates(
        { limit: 1, leaseMs: 60_000 },
        testDb,
      );
      if (!claim) throw new Error("expected success claim");
      await recordFreeModelProbeResult({
        modelId,
        claimToken: claim.claimToken,
        outcome: "success",
        nextProbeAt: new Date(Date.now() - 1_000),
        httpStatus: 200,
        latencyMs: 20,
      }, testDb);
      const [candidate] = await client.unsafe(`
        select state, success_streak, ever_qualified
        from free_model_candidates where model_id = '${modelId}'`);
      expect(candidate?.state).toBe(expectedState);
    }

    const [systemClaim] = await claimDueFreeModelCandidates(
      { limit: 1, leaseMs: 60_000 },
      testDb,
    );
    if (!systemClaim) throw new Error("expected system failure claim");
    await recordFreeModelProbeResult({
      modelId,
      claimToken: systemClaim.claimToken,
      outcome: "system_failure",
      nextProbeAt: new Date(Date.now() - 1_000),
      errorCode: "provider_capacity",
    }, testDb);
    const [afterSystemFailure] = await client.unsafe(`
      select state, success_streak, failure_streak
      from free_model_candidates where model_id = '${modelId}'`);
    expect(afterSystemFailure).toMatchObject({
      state: "qualified",
      success_streak: 2,
      failure_streak: 0,
    });

    for (const expectedState of ["qualified", "disqualified"] as const) {
      const [claim] = await claimDueFreeModelCandidates(
        { limit: 1, leaseMs: 60_000 },
        testDb,
      );
      if (!claim) throw new Error("expected failure claim");
      await recordFreeModelProbeResult({
        modelId,
        claimToken: claim.claimToken,
        outcome: "failure",
        nextProbeAt: new Date(Date.now() - 1_000),
        httpStatus: 429,
        latencyMs: 30,
        errorCode: "rate_limited",
      }, testDb);
      const [candidate] = await client.unsafe(`
        select state from free_model_candidates where model_id = '${modelId}'`);
      expect(candidate?.state).toBe(expectedState);
    }
  });

  test("rejects unsanitized error text before it reaches the attempt ledger", async () => {
    const modelId = `test/sanitize-${crypto.randomUUID()}:free`;
    await insertCandidate(modelId);
    await makeOnlyDue(modelId);
    const [claim] = await claimDueFreeModelCandidates(
      { limit: 1, leaseMs: 60_000 },
      testDb,
    );
    if (!claim) throw new Error("expected claim");

    await expect(recordFreeModelProbeResult({
      modelId,
      claimToken: claim.claimToken,
      outcome: "failure",
      nextProbeAt: new Date(Date.now() + 60_000),
      errorCode: "Bearer secret must not be stored" as never,
    }, testDb)).rejects.toThrow("free_model_probe_error_code_not_sanitized");
    const [attempts] = await client.unsafe(`
      select count(*)::int as count from free_model_probe_attempts
      where model_id = '${modelId}'`);
    expect(Number(attempts?.count)).toBe(0);
  });

  test("daily budget is global and resets at the next UTC day", async () => {
    const firstModel = `test/budget-a-${crypto.randomUUID()}:free`;
    const secondModel = `test/budget-b-${crypto.randomUUID()}:free`;
    await insertCandidate(firstModel);
    await insertCandidate(secondModel);
    await client.unsafe(`
      update free_model_candidates
      set next_probe_at = case
        when model_id in ('${firstModel}', '${secondModel}')
          then now() - interval '1 second'
        else now() + interval '1 day'
      end`);
    await client.unsafe(`
      update free_model_registry_state
      set daily_probe_budget = 1, probes_claimed_today = 0
      where lane = 'opencode_free'`);

    const claims = await Promise.all([
      claimDueFreeModelCandidates({ limit: 1, leaseMs: 60_000 }, dbA),
      claimDueFreeModelCandidates({ limit: 1, leaseMs: 60_000 }, dbB),
    ]);
    expect(claims.flat()).toHaveLength(1);
    await expect(claimDueFreeModelCandidates(
      { limit: 1, leaseMs: 60_000 },
      testDb,
    )).resolves.toEqual([]);

    await client.unsafe(`
      update free_model_registry_state
      set probe_budget_day = ((now() at time zone 'UTC')::date - 1),
        probes_claimed_today = 1
      where lane = 'opencode_free'`);
    await client.unsafe(`
      update free_model_candidates
      set claim_expires_at = now() - interval '1 second'
      where claim_token is not null`);
    const afterReset = await claimDueFreeModelCandidates(
      { limit: 1, leaseMs: 60_000 },
      testDb,
    );
    expect(afterReset).toHaveLength(1);
  });

  test("publishing preserves last-good on empty or system failure and advances atomically", async () => {
    const before = await loadCurrentFreeModelLane(FREE_MODEL_LANE, testDb);
    if (!before) throw new Error("expected seeded lane");

    const empty = await publishFreeModelLane({ modelIds: [] }, testDb);
    expect(empty).toMatchObject({
      outcome: "preserved_empty",
      state: {
        generation: before.generation,
        currentModelIds: before.currentModelIds,
        lastGoodModelIds: before.lastGoodModelIds,
      },
    });
    const failed = await publishFreeModelLane({
      modelIds: [SEED_MODELS[0]],
      systemFailure: true,
    }, testDb);
    expect(failed).toMatchObject({
      outcome: "preserved_system_failure",
      state: { generation: before.generation, currentModelIds: before.currentModelIds },
    });

    const modelId = `test/publish-${crypto.randomUUID()}:free`;
    await insertCandidate(modelId, "qualified");
    await client.unsafe(`
      update free_model_candidates
      set ever_qualified = true, success_streak = 2
      where model_id = '${modelId}'`);
    const published = await publishFreeModelLane({ modelIds: [modelId] }, testDb);
    expect(published).toMatchObject({
      outcome: "published",
      state: {
        generation: before.generation + 1,
        currentModelIds: [modelId],
        lastGoodModelIds: [modelId],
      },
    });
    const advertised = await client.unsafe(`
      select model_id from free_model_candidates
      where advertised = true order by model_id`);
    expect(advertised.map((row) => row.model_id)).toEqual([modelId]);
  });

  test("an unqualified publish fails without changing the current generation", async () => {
    const modelId = `test/unqualified-${crypto.randomUUID()}:free`;
    await insertCandidate(modelId);
    const before = await loadCurrentFreeModelLane(FREE_MODEL_LANE, testDb);
    await expect(publishFreeModelLane({ modelIds: [modelId] }, testDb))
      .rejects.toThrow("free_model_publish_contains_unqualified_candidate");
    const after = await loadCurrentFreeModelLane(FREE_MODEL_LANE, testDb);
    expect(after).toMatchObject({
      generation: before?.generation,
      currentModelIds: before?.currentModelIds,
      lastGoodModelIds: before?.lastGoodModelIds,
    });
  });
});
