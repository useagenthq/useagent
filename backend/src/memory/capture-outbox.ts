import { eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { memoryOutbox } from "../db/schema";
import { deliverTeamMemory, type MemoryIdentity } from "./team-memory";

// ---------------------------------------------------------------------------
// Durable capture outbox for team memory (memory Phase 3b) — persistence +
// delivery in one small module (one concern: reliably write a run's outcome to
// team memory). Replaces the old fire-and-forget POST that was lost on ANY
// failure. Mirrors slack_outbox's shape/backoff; kept SEPARATE by design (no
// shared outbox framework this cycle — convergence noted in the progress log).
//
// AT-MOST-once delivery: /v3/conversation/add has NO idempotency key, so a
// re-delivery would create a duplicate L0 turn. A row orphaned in `delivering`
// by a crash is therefore NEVER auto-reset to pending (no resetStuckDelivering —
// the opposite of the Slack outbox) — it awaits manual inspection. That trades a
// rare lost capture for never duplicating a team-memory turn.
// ---------------------------------------------------------------------------

const PAYLOAD_CAP = 16_384;
const BASE_BACKOFF_MS = 30_000; // 30s, doubling
const MAX_BACKOFF_MS = 3_600_000; // capped at 1h

interface CapturePayload {
  readonly identity: MemoryIdentity;
  readonly prompt: string;
  readonly summary: string;
}

/** Next retry time: exponential backoff (30s·2^attempt), capped at 1h. Pure. */
export function backoffAt(now: number, attempt: number): Date {
  return new Date(now + Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS));
}

/** The row's state after a delivery outcome — retry until maxAttempts, then dead.
 *  Pure (the retry/dead policy), so it's unit-tested without a DB. */
export function nextOutboxState(
  ok: boolean,
  attemptCount: number,
  maxAttempts: number,
): "delivered" | "retry" | "dead" {
  if (ok) return "delivered";
  return attemptCount + 1 >= maxAttempts ? "dead" : "retry";
}

/**
 * Enqueue a run's captured outcome. Idempotent by runId (id = runId) — a
 * duplicate enqueue or a retried finalization never creates a second row, so a
 * capture is delivered AT MOST once per run. The committed row IS the durable
 * intent to deliver; the loop below does the (retryable) network call.
 */
export async function enqueueCapture(
  runId: string,
  identity: MemoryIdentity,
  run: { prompt: string; summary: string },
  /** Enqueue inside the run-finalization transaction (runs/finalize.ts) so the
   *  capture intent commits ATOMICALLY with the run reaching `completed` — a crash
   *  in the old completeRun→enqueue gap could otherwise lose it forever. Defaults
   *  to the shared pool for standalone callers. */
  exec: Executor = db,
): Promise<void> {
  const payload = JSON.stringify({
    identity,
    prompt: run.prompt,
    summary: run.summary,
  } satisfies CapturePayload).slice(0, PAYLOAD_CAP);
  await exec
    .insert(memoryOutbox)
    .values({ id: runId, runId, payload })
    .onConflictDoNothing({ target: memoryOutbox.id });
}

interface ClaimedRow {
  readonly id: string;
  readonly payload: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

/** Atomically claim due pending rows → `delivering` (CTE + FOR UPDATE SKIP
 *  LOCKED), so a concurrent worker can't double-send. Due is the DB clock. */
async function claimDue(limit: number): Promise<ClaimedRow[]> {
  const rows = (await db.execute(sql`
    with due as (
      select id from memory_outbox
      where state = 'pending' and next_attempt_at <= now()
      order by next_attempt_at asc
      limit ${limit}
      for update skip locked
    )
    update memory_outbox o set state = 'delivering', updated_at = now()
    from due where o.id = due.id
    returning o.id, o.payload, o.attempt_count, o.max_attempts`)) as unknown as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: r.id as string,
    payload: r.payload as string,
    attemptCount: Number(r.attempt_count),
    maxAttempts: Number(r.max_attempts),
  }));
}

async function markDelivered(id: string): Promise<void> {
  await db
    .update(memoryOutbox)
    .set({ state: "delivered", lastError: null, updatedAt: new Date() })
    .where(eq(memoryOutbox.id, id));
}

async function markRetry(id: string, nextAttemptAt: Date, lastError: string): Promise<void> {
  await db
    .update(memoryOutbox)
    .set({
      state: "pending",
      attemptCount: sql`${memoryOutbox.attemptCount} + 1`,
      nextAttemptAt,
      lastError: lastError.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(memoryOutbox.id, id));
}

async function markDead(id: string, lastError: string): Promise<void> {
  await db
    .update(memoryOutbox)
    .set({
      state: "dead",
      attemptCount: sql`${memoryOutbox.attemptCount} + 1`,
      lastError: lastError.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(memoryOutbox.id, id));
}

/**
 * Deliver up to `limit` due captures. Each claimed row is delivered via
 * deliverTeamMemory; the outcome routes it to delivered / retry (with backoff) /
 * dead (past maxAttempts). An unparseable payload is dead-lettered immediately
 * (never retried). Returns counts for the loop/tests. Never throws.
 */
export async function deliverDueCaptures(
  limit = 20,
): Promise<{ delivered: number; retried: number; dead: number }> {
  const rows = await claimDue(limit);
  let delivered = 0;
  let retried = 0;
  let dead = 0;
  for (const row of rows) {
    let parsed: CapturePayload | null = null;
    try {
      parsed = JSON.parse(row.payload) as CapturePayload;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      await markDead(row.id, "unparseable payload");
      dead++;
      continue;
    }
    let ok = false;
    try {
      ok = await deliverTeamMemory({ prompt: parsed.prompt, summary: parsed.summary }, parsed.identity);
    } catch {
      ok = false;
    }
    const outcome = nextOutboxState(ok, row.attemptCount, row.maxAttempts);
    if (outcome === "delivered") {
      await markDelivered(row.id);
      delivered++;
    } else if (outcome === "dead") {
      await markDead(row.id, "delivery failed after max attempts");
      dead++;
    } else {
      await markRetry(row.id, backoffAt(Date.now(), row.attemptCount + 1), "delivery failed");
      retried++;
    }
  }
  return { delivered, retried, dead };
}

/** Ops/test read helper — inspect a run's capture row (incl. crash-orphaned
 *  `delivering` rows, which are recovered manually, never auto-retried). */
export async function getCapture(runId: string) {
  const [row] = await db.select().from(memoryOutbox).where(eq(memoryOutbox.id, runId)).limit(1);
  return row ?? null;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the delivery loop (idempotent). Best-effort: a tick failure is logged,
 *  never thrown; memory disabled is safe (deliverTeamMemory no-ops to success).
 *  `MEMORY_OUTBOX_TICK_MS` overrides the interval (tests/E2E go fast; mirrors
 *  SLACK_OUTBOX_TICK_MS). */
export function startCaptureDelivery(
  intervalMs = Number(process.env.MEMORY_OUTBOX_TICK_MS ?? 15_000),
): void {
  if (timer) return;
  timer = setInterval(() => {
    void deliverDueCaptures().catch((err) =>
      console.error("[memory-outbox] delivery tick failed:", err),
    );
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
