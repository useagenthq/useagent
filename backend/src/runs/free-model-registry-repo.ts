import { asc, eq, sql } from "drizzle-orm";
import { db, type Db, type Executor } from "../db/client";
import {
  freeModelCandidates,
  freeModelProbeAttempts,
  freeModelRegistryState,
  FREE_MODEL_PROBE_ERROR_CODES,
  type FreeModelCandidateRow,
  type FreeModelProbeErrorCode,
  type FreeModelProbeOutcome,
  type FreeModelRegistryStateRow,
} from "../db/schema";

export const FREE_MODEL_LANE = "opencode_free";
export const DEFAULT_DAILY_FREE_MODEL_PROBE_BUDGET = 24;
export const FREE_MODEL_QUALIFICATION_STREAK = 2;
export const FREE_MODEL_DISQUALIFICATION_STREAK = 2;
export const FREE_MODEL_SYSTEM_PAUSE_MS = 30 * 60_000;

export interface ClaimedFreeModelCandidate {
  readonly modelId: string;
  readonly provider: string;
  readonly state: FreeModelCandidateRow["state"];
  readonly successStreak: number;
  readonly failureStreak: number;
  readonly everQualified: boolean;
  readonly claimToken: string;
  readonly claimExpiresAt: Date;
}

export interface DiscoveredFreeModelCandidate {
  readonly modelId: string;
  readonly provider: string;
  readonly source: string;
}

/** Persist catalog discovery without resetting qualification or retry state. */
export async function upsertDiscoveredFreeModelCandidates(
  candidates: readonly DiscoveredFreeModelCandidate[],
  exec: Executor = db,
): Promise<number> {
  const unique = [...new Map(
    candidates
      .filter((candidate) => candidate.modelId.trim())
      .map((candidate) => [candidate.modelId, candidate]),
  ).values()];
  if (unique.length === 0) return 0;
  const now = new Date();
  const rows = await exec
    .insert(freeModelCandidates)
    .values(unique.map((candidate) => ({
      modelId: candidate.modelId,
      provider: candidate.provider,
      source: candidate.source,
      nextProbeAt: now,
    })))
    .onConflictDoUpdate({
      target: freeModelCandidates.modelId,
      // Preserve probe scheduling, claims, streaks, and first-source provenance.
      // updated_at is only a bounded freshness heartbeat for the catalog row.
      set: { updatedAt: now },
    })
    .returning({ modelId: freeModelCandidates.modelId });
  return rows.length;
}

export interface ClaimDueFreeModelCandidatesInput {
  readonly limit: number;
  readonly leaseMs: number;
  readonly lane?: string;
}

/**
 * Claim due candidates and consume the global UTC-day probe budget atomically.
 * The registry row serializes budget accounting; SKIP LOCKED fences candidate
 * ownership across workers without making an expired lease unrecoverable.
 */
export async function claimDueFreeModelCandidates(
  input: ClaimDueFreeModelCandidatesInput,
  database: Db = db,
): Promise<ClaimedFreeModelCandidate[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 0) {
    throw new Error("free_model_claim_limit_invalid");
  }
  if (input.limit === 0) return [];
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    throw new Error("free_model_claim_lease_invalid");
  }
  const lane = input.lane ?? FREE_MODEL_LANE;

  return database.transaction(async (tx) => {
    const [budget] = await tx.execute(sql`
      select daily_probe_budget, probes_claimed_today,
        probe_budget_day::text as probe_budget_day,
        ((now() at time zone 'UTC')::date)::text as utc_day,
        last_publish_outcome,
        last_publish_at > now() - (${FREE_MODEL_SYSTEM_PAUSE_MS}::bigint * interval '1 millisecond')
          as system_paused
      from free_model_registry_state
      where lane = ${lane}
      for update`);
    if (!budget) throw new Error("free_model_registry_state_missing");

    const budgetDay = String(budget.probe_budget_day);
    const utcDay = String(budget.utc_day);
    let probesClaimedToday = Number(budget.probes_claimed_today);
    const dailyProbeBudget = Number(budget.daily_probe_budget);
    if (budgetDay !== utcDay) {
      probesClaimedToday = 0;
      await tx.execute(sql`
        update free_model_registry_state
        set probe_budget_day = ${utcDay}::date,
          probes_claimed_today = 0,
          updated_at = now()
        where lane = ${lane}`);
    }

    if (
      budget.last_publish_outcome === "preserved_system_failure" &&
      budget.system_paused === true
    ) {
      return [];
    }

    // The registry-row lock serializes this check with every other replica's
    // claim transaction. One unexpired candidate lease therefore means one
    // globally active provider probe, not one active probe per process.
    const [active] = await tx.execute(sql`
      select exists(
        select 1 from free_model_candidates
        where claim_token is not null and claim_expires_at > now()
      ) as active`);
    if (active?.active === true) return [];

    const claimLimit = Math.min(
      input.limit,
      Math.max(0, dailyProbeBudget - probesClaimedToday),
    );
    if (claimLimit === 0) return [];

    const rows = await tx.execute(sql`
      update free_model_candidates candidate
      set claim_token = gen_random_uuid(),
        claim_expires_at = now() + (${input.leaseMs}::bigint * interval '1 millisecond'),
        last_claimed_at = now(),
        updated_at = now()
      where candidate.model_id in (
        select due.model_id
        from free_model_candidates due
        where due.state <> 'disabled'
          and due.next_probe_at <= now()
          and (due.claim_token is null or due.claim_expires_at <= now())
        order by due.next_probe_at asc, due.model_id asc
        limit ${claimLimit}
        for update skip locked
      )
      returning candidate.model_id, candidate.provider, candidate.state,
        candidate.success_streak, candidate.failure_streak, candidate.ever_qualified,
        candidate.claim_token, candidate.claim_expires_at`);

    if (rows.length > 0) {
      await tx.execute(sql`
        update free_model_registry_state
        set probes_claimed_today = probes_claimed_today + ${rows.length},
          updated_at = now()
        where lane = ${lane}`);
    }
    return rows.map((row) => ({
      modelId: String(row.model_id),
      provider: String(row.provider),
      state: row.state as FreeModelCandidateRow["state"],
      successStreak: Number(row.success_streak),
      failureStreak: Number(row.failure_streak),
      everQualified: Boolean(row.ever_qualified),
      claimToken: String(row.claim_token),
      claimExpiresAt: new Date(String(row.claim_expires_at)),
    }));
  });
}

export interface RecordFreeModelProbeResultInput {
  readonly modelId: string;
  readonly claimToken: string;
  readonly outcome: FreeModelProbeOutcome;
  readonly nextProbeAt: Date;
  readonly httpStatus?: number | null;
  readonly latencyMs?: number | null;
  /** Sanitized machine code only. Raw provider errors and bodies are forbidden. */
  readonly errorCode?: FreeModelProbeErrorCode | null;
}

const PROBE_ERROR_CODES = new Set<FreeModelProbeErrorCode>(
  FREE_MODEL_PROBE_ERROR_CODES,
);

function validatedErrorCode(
  errorCode: FreeModelProbeErrorCode | null | undefined,
): FreeModelProbeErrorCode | null {
  if (errorCode == null) return null;
  if (!PROBE_ERROR_CODES.has(errorCode)) {
    throw new Error("free_model_probe_error_code_not_sanitized");
  }
  return errorCode;
}

function validateProbeResult(input: RecordFreeModelProbeResultInput): void {
  if (!Number.isFinite(input.nextProbeAt.getTime())) {
    throw new Error("free_model_next_probe_at_invalid");
  }
  if (
    input.httpStatus != null &&
    (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)
  ) {
    throw new Error("free_model_probe_http_status_invalid");
  }
  if (
    input.latencyMs != null &&
    (!Number.isInteger(input.latencyMs) || input.latencyMs < 0 || input.latencyMs > 3_600_000)
  ) {
    throw new Error("free_model_probe_latency_invalid");
  }
}

/**
 * Persist a sanitized probe attempt and transition its candidate in one
 * transaction. An expired or replaced claim token writes nothing and returns
 * false, preventing a slow worker from overwriting newer evidence.
 */
export async function recordFreeModelProbeResult(
  input: RecordFreeModelProbeResultInput,
  database: Db = db,
): Promise<boolean> {
  validateProbeResult(input);
  const errorCode = validatedErrorCode(input.errorCode);

  return database.transaction(async (tx) => {
    const [candidate] = await tx.execute(sql`
      select model_id
      from free_model_candidates
      where model_id = ${input.modelId}
        and claim_token = ${input.claimToken}::uuid
        and claim_expires_at > now()
      for update`);
    if (!candidate) return false;

    await tx.insert(freeModelProbeAttempts).values({
      modelId: input.modelId,
      claimToken: input.claimToken,
      outcome: input.outcome,
      httpStatus: input.httpStatus ?? null,
      latencyMs: input.latencyMs ?? null,
      errorCode,
    });

    const isSuccess = input.outcome === "success";
    const isFailure = input.outcome === "failure";
    await tx.execute(sql`
      update free_model_candidates
      set success_streak = case
            when ${isSuccess} then success_streak + 1
            when ${isFailure} then 0
            else success_streak
          end,
        failure_streak = case
            when ${isFailure} then failure_streak + 1
            when ${isSuccess} then 0
            else failure_streak
          end,
        state = case
            when state = 'disabled' then 'disabled'
            when ${isSuccess} and success_streak + 1 >= ${FREE_MODEL_QUALIFICATION_STREAK}
              then 'qualified'
            when ${isFailure} and failure_streak + 1 >= ${FREE_MODEL_DISQUALIFICATION_STREAK}
              then 'disqualified'
            else state
          end,
        ever_qualified = ever_qualified or
          (${isSuccess} and success_streak + 1 >= ${FREE_MODEL_QUALIFICATION_STREAK}),
        qualified_at = case
          when ${isSuccess} and success_streak + 1 >= ${FREE_MODEL_QUALIFICATION_STREAK}
            then coalesce(qualified_at, now())
          else qualified_at
        end,
        attempt_count = attempt_count + 1,
        next_probe_at = ${input.nextProbeAt.toISOString()}::timestamptz,
        claim_token = null,
        claim_expires_at = null,
        last_probe_at = now(),
        last_success_at = case when ${isSuccess} then now() else last_success_at end,
        last_failure_at = case when ${isFailure} then now() else last_failure_at end,
        last_outcome = ${input.outcome},
        updated_at = now()
      where model_id = ${input.modelId}`);
    return true;
  });
}

export interface PublishFreeModelLaneInput {
  readonly modelIds: readonly string[];
  readonly systemFailure?: boolean;
  readonly lane?: string;
  readonly expectedGeneration?: number;
}

export type PublishFreeModelLaneResult =
  | { readonly outcome: "published"; readonly state: FreeModelRegistryStateRow }
  | {
      readonly outcome: "preserved_empty" | "preserved_system_failure";
      readonly state: FreeModelRegistryStateRow;
    };

function uniqueModelIds(modelIds: readonly string[]): string[] {
  return [...new Set(modelIds.map((modelId) => modelId.trim()).filter(Boolean))];
}

/**
 * Atomically publish a new non-empty qualified lane generation. Empty discovery
 * and system failures only record the failed publish outcome; the last-good
 * generation and advertised candidate set remain untouched.
 */
export async function publishFreeModelLane(
  input: PublishFreeModelLaneInput,
  database: Db = db,
): Promise<PublishFreeModelLaneResult> {
  const lane = input.lane ?? FREE_MODEL_LANE;
  const modelIds = uniqueModelIds(input.modelIds);

  return database.transaction(async (tx) => {
    const [locked] = await tx.execute(sql`
      select lane, generation from free_model_registry_state where lane = ${lane} for update`);
    if (!locked) throw new Error("free_model_registry_state_missing");
    if (
      input.expectedGeneration !== undefined &&
      Number(locked.generation) !== input.expectedGeneration
    ) {
      throw new Error("free_model_publish_generation_conflict");
    }

    const preservedOutcome = input.systemFailure
      ? "preserved_system_failure"
      : modelIds.length === 0
        ? "preserved_empty"
        : null;
    if (preservedOutcome) {
      const [state] = await tx
        .update(freeModelRegistryState)
        .set({
          lastPublishOutcome: preservedOutcome,
          lastPublishAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(freeModelRegistryState.lane, lane))
        .returning();
      if (!state) throw new Error("free_model_registry_state_missing");
      return { outcome: preservedOutcome, state };
    }

    const qualified = await tx.execute(sql`
      select model_id from free_model_candidates
      where model_id in (${sql.join(modelIds.map((id) => sql`${id}`), sql`, `)})
        and state = 'qualified'
        and ever_qualified = true`);
    if (qualified.length !== modelIds.length) {
      throw new Error("free_model_publish_contains_unqualified_candidate");
    }

    await tx.execute(sql`
      update free_model_candidates
      set advertised = model_id in (
          ${sql.join(modelIds.map((id) => sql`${id}`), sql`, `)}
        ),
        updated_at = now()
      where advertised = true
        or model_id in (${sql.join(modelIds.map((id) => sql`${id}`), sql`, `)})`);

    const encodedModelIds = JSON.stringify(modelIds);
    const [state] = await tx
      .update(freeModelRegistryState)
      .set({
        generation: sql`${freeModelRegistryState.generation} + 1`,
        currentModelIds: sql`${encodedModelIds}::jsonb`,
        lastGoodModelIds: sql`${encodedModelIds}::jsonb`,
        lastPublishOutcome: "published",
        lastPublishAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(freeModelRegistryState.lane, lane))
      .returning();
    if (!state) throw new Error("free_model_registry_state_missing");
    return {
      outcome: "published",
      state,
    };
  });
}

export async function loadCurrentFreeModelLane(
  lane = FREE_MODEL_LANE,
  exec: Executor = db,
): Promise<FreeModelRegistryStateRow | null> {
  const [state] = await exec
    .select()
    .from(freeModelRegistryState)
    .where(eq(freeModelRegistryState.lane, lane))
    .limit(1);
  return state ?? null;
}

export interface FreeModelRegistrySnapshot {
  readonly state: FreeModelRegistryStateRow | null;
  readonly candidates: readonly FreeModelCandidateRow[];
}

export async function loadFreeModelRegistry(
  lane = FREE_MODEL_LANE,
  exec: Executor = db,
): Promise<FreeModelRegistrySnapshot> {
  const state = await loadCurrentFreeModelLane(lane, exec);
  const candidates = await exec
    .select()
    .from(freeModelCandidates)
    .orderBy(asc(freeModelCandidates.modelId));
  return { state, candidates };
}
