import { eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { learningOutbox, type LearningOutboxStatus, type MemoryScope } from "../db/schema";
import { proposeKnowledgeDraftForRun } from "./drafts";
import { errorMessage } from "../util/error-message";

// ---------------------------------------------------------------------------
// Durable learning outbox (self_improving 6.1). The learning candidate used to
// be built by a POST-COMMIT call in finalizeRun (drafts.proposeKnowledgeDraftForRun),
// which left a crash window: a run could reach `completed` and never learn from
// (a crash between the commit and the call lost the intent, and neither
// re-finalize nor boot-reconcile re-armed it). This outbox closes it: the intent
// row is written INSIDE the finalization transaction, so it commits atomically
// with the terminal run. A boot-started worker then builds the candidate off the
// committed intent, with retry + dead-letter, and NEVER fails the run.
//
// AT-LEAST-once: building a candidate is IDEMPOTENT (proposeKnowledgeDraftForRun
// upserts one knowledge_draft per run via onConflictDoNothing), so a re-processed
// row cannot duplicate. That lets a crash-orphaned `processing` row be safely
// reset to `pending` at boot (unlike the at-most-once memory capture outbox).
// Mirrors the capture/canonicalization outbox shape (claim CTE + backoff).
// ---------------------------------------------------------------------------

const BASE_BACKOFF_MS = 30_000; // 30s, doubling
const MAX_BACKOFF_MS = 3_600_000; // capped at 1h

/** The current candidate-builder policy version, recorded per enqueued row so a
 *  later builder change is auditable (self_improving 6.1). Bump when the
 *  extraction/classification policy changes in a way reviewers should see. */
export const LEARNING_POLICY_VERSION = 1;

/** Next retry time: exponential backoff (30s·2^attempt), capped at 1h. Pure. */
export function learningBackoffAt(now: number, attempt: number): Date {
  return new Date(now + Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS));
}

/** The row's next status after a build outcome — retry until maxAttempts, then
 *  dead. Pure (the retry/dead policy), so it is unit-tested without a DB. */
export function nextLearningStatus(
  ok: boolean,
  attempts: number,
  maxAttempts: number,
): "done" | "retry" | "dead" {
  if (ok) return "done";
  return attempts + 1 >= maxAttempts ? "dead" : "retry";
}

export interface EnqueueLearningInput {
  runId: string;
  orgId: string;
  userId: string | null;
  memoryScope: MemoryScope;
  origin: string | null;
}

/**
 * Enqueue a run's learning intent. Idempotent by runId (PK) — a re-finalization
 * of an already-enqueued run re-arms a non-terminal row for a retry but never
 * regresses a `done` row and never creates a second. Call INSIDE the run-
 * finalization transaction so the intent commits ATOMICALLY with the terminal
 * run (self_improving 6.1). Defaults to the shared pool for standalone callers.
 */
export async function enqueueLearning(
  input: EnqueueLearningInput,
  exec: Executor = db,
): Promise<void> {
  await exec
    .insert(learningOutbox)
    .values({
      runId: input.runId,
      orgId: input.orgId,
      userId: input.userId,
      memoryScope: input.memoryScope,
      origin: input.origin,
      policyVersion: LEARNING_POLICY_VERSION,
    })
    .onConflictDoUpdate({
      target: learningOutbox.runId,
      set: {
        // Never regress a completed candidate; otherwise re-arm for a retry.
        status: sql`case when ${learningOutbox.status} = 'done' then 'done' else 'pending' end`,
        nextAttemptAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    });
}

interface ClaimedRow {
  runId: string;
  attempts: number;
  maxAttempts: number;
}

/** Atomically claim due pending rows -> `processing` (CTE + FOR UPDATE SKIP
 *  LOCKED), so a concurrent worker can't double-process. Due is the DB clock. */
async function claimDue(limit: number): Promise<ClaimedRow[]> {
  const rows = (await db.execute(sql`
    with due as (
      select run_id from learning_outbox
      where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at asc
      limit ${limit}
      for update skip locked
    )
    update learning_outbox o set status = 'processing', updated_at = now()
    from due where o.run_id = due.run_id
    returning o.run_id, o.attempts, o.max_attempts`)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    runId: r.run_id as string,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
  }));
}

async function markDone(runId: string): Promise<void> {
  await db
    .update(learningOutbox)
    .set({ status: "done", lastError: null, updatedAt: new Date() })
    .where(eq(learningOutbox.runId, runId));
}

async function markRetry(runId: string, nextAttemptAt: Date, lastError: string): Promise<void> {
  await db
    .update(learningOutbox)
    .set({
      status: "pending",
      attempts: sql`${learningOutbox.attempts} + 1`,
      nextAttemptAt,
      lastError: lastError.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(learningOutbox.runId, runId));
}

async function markDead(runId: string, lastError: string): Promise<void> {
  await db
    .update(learningOutbox)
    .set({
      status: "dead",
      attempts: sql`${learningOutbox.attempts} + 1`,
      lastError: lastError.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(learningOutbox.runId, runId));
}

/** Builds a run's learning candidate; returns a truthy value when a candidate
 *  was produced, null when the run was ineligible (a clean skip). Injectable so
 *  the worker's retry/dead-letter policy is testable without a real build. */
export type CandidateBuilder = (runId: string) => Promise<unknown | null>;

/**
 * Process up to `limit` due learning intents. Each claimed row builds its
 * candidate via the idempotent proposeKnowledgeDraftForRun; a build error routes
 * to retry (with backoff) / dead (past maxAttempts). A run that turns out
 * ineligible (missing / not high-value / gated out by the verified-outcome gate)
 * is a CLEAN `done` (nothing to learn — not an error). Returns counts. Never
 * throws. `build` is injectable for tests (defaults to the real builder).
 */
export async function processDueLearning(
  limit = 20,
  build: CandidateBuilder = proposeKnowledgeDraftForRun,
): Promise<{ built: number; skipped: number; retried: number; dead: number }> {
  const rows = await claimDue(limit);
  let built = 0;
  let skipped = 0;
  let retried = 0;
  let dead = 0;
  for (const row of rows) {
    try {
      const draft = await build(row.runId);
      await markDone(row.runId);
      if (draft) built++;
      else skipped++;
    } catch (err) {
      const message = errorMessage(err);
      const outcome = nextLearningStatus(false, row.attempts, row.maxAttempts);
      if (outcome === "dead") {
        await markDead(row.runId, `build failed after max attempts: ${message}`);
        dead++;
      } else {
        await markRetry(row.runId, learningBackoffAt(Date.now(), row.attempts + 1), message);
        retried++;
      }
    }
  }
  return { built, skipped, retried, dead };
}

/** Ops/test read helper — inspect a run's learning-outbox row. */
export async function getLearningIntent(runId: string) {
  const [row] = await db.select().from(learningOutbox).where(eq(learningOutbox.runId, runId)).limit(1);
  return row ?? null;
}

/** Boot recovery: a crash mid-build leaves a `processing` row stranded. Reset it
 *  to `pending` — SAFE because candidate building is idempotent (one draft per
 *  run), unlike the at-most-once memory capture outbox. Returns how many. */
export async function resetStuckLearning(): Promise<number> {
  const rows = (await db.execute(sql`
    update learning_outbox set status = 'pending', updated_at = now()
    where status = 'processing' returning run_id`)) as unknown as unknown[];
  return rows.length;
}

/** List an org's learning-outbox rows, newest first (operator surface). Includes
 *  every status; dead rows carry the operator-visible reason in last_error. */
export interface LearningIntentAdminRow {
  runId: string;
  status: LearningOutboxStatus;
  attempts: number;
  maxAttempts: number;
  policyVersion: number;
  lastError: string | null;
  nextAttemptAt: string;
  updatedAt: string;
}

export async function listLearningIntentsForOrg(
  orgId: string,
  limit = 50,
): Promise<LearningIntentAdminRow[]> {
  const rows = await db
    .select()
    .from(learningOutbox)
    .where(eq(learningOutbox.orgId, orgId))
    .orderBy(sql`updated_at desc`)
    .limit(limit);
  return rows.map((r) => ({
    runId: r.runId,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    policyVersion: r.policyVersion,
    lastError: r.lastError,
    nextAttemptAt: r.nextAttemptAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the learning delivery loop (idempotent). Best-effort: a tick failure is
 *  logged, never thrown. `LEARNING_OUTBOX_TICK_MS` overrides the interval
 *  (tests/E2E go fast; mirrors MEMORY_OUTBOX_TICK_MS). */
export function startLearningOutbox(
  intervalMs = Number(process.env.LEARNING_OUTBOX_TICK_MS ?? 15_000),
): void {
  if (timer) return;
  timer = setInterval(() => {
    void processDueLearning().catch((err) =>
      console.error("[learning-outbox] delivery tick failed:", err),
    );
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
