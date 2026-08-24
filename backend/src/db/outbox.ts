import { sql } from "drizzle-orm";
import { db } from "./client";

// ---------------------------------------------------------------------------
// Shared transactional-outbox primitive.
//
// memory-capture, canonicalization, and learning each hand-rolled the SAME
// claim / retry-schedule / dead-letter mechanics against differently-named
// columns. This is the one implementation; each domain supplies an OutboxTable
// descriptor + a BackoffPolicy and keeps its own delivery logic, error strings,
// and terminal-success semantics. Behavior is UNCHANGED per domain - the backoff
// WINDOW, batch sizes, and dead-letter thresholds stay per-domain by parameter.
//
// The columns that differ between the three tables are the key, the state/status
// column, the attempt-counter column, and the in-flight state literal; everything
// else (max_attempts, next_attempt_at, last_error, updated_at, and the 'pending'/
// 'dead' literals) is identical and hardcoded here. All descriptor values are
// compile-time constants owned by this codebase, never user input; identifiers
// are still escaped via sql.identifier.
//
// Slack's delivery queue (src/slack/outbox/) keeps its own copy on purpose: it
// adds jittered + env-configurable backoff and boot-wakeup semantics that are out
// of this refactor's scope. The BackoffPolicy.jitter field exists so it could
// converge here later without a fork.
// ---------------------------------------------------------------------------

/** The per-table column names + state literals a generic outbox query needs. */
export interface OutboxTable {
  /** Physical table name, e.g. "memory_outbox". */
  readonly table: string;
  /** The claim/where key column: "id" (memory) or "run_id" (canon, learning). */
  readonly key: string;
  /** The state/status column: "state" or "status". */
  readonly stateColumn: string;
  /** The attempt-counter column: "attempt_count" or "attempts". */
  readonly attemptColumn: string;
  /** State a row is claimable in. */
  readonly pending: string;
  /** State a row flips to when claimed (in-flight): "delivering" | "translating" | "processing". */
  readonly claimed: string;
  /** Terminal failure state. */
  readonly dead: string;
}

/** Exponential-backoff schedule: delay = min(baseMs*2^attempt, maxMs), optionally
 *  spread by +/- `jitter` (0..1) of the delay to avoid a retry thundering herd. */
export interface BackoffPolicy {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly jitter?: number;
}

/** Next retry time for `attempt`: exponential backoff capped at maxMs. Pure (and
 *  deterministic) unless a `jitter` fraction is set - the three migrated domains
 *  omit it, so this is exactly `now + min(baseMs*2^attempt, maxMs)`. */
export function backoffAt(policy: BackoffPolicy, now: number, attempt: number): Date {
  const delay = Math.min(policy.baseMs * 2 ** attempt, policy.maxMs);
  if (!policy.jitter) return new Date(now + delay);
  return new Date(now + delay + delay * policy.jitter * (Math.random() * 2 - 1));
}

/** Whether the NEXT failure dead-letters the row: attempt+1 has reached the cap.
 *  Pure - the shared retry/dead threshold. */
export function isDeadLetter(attempt: number, maxAttempts: number): boolean {
  return attempt + 1 >= maxAttempts;
}

/** A delivery attempt's outcome: success, else retry until the dead-letter
 *  threshold. Pure. Callers map 'success' to their terminal literal (e.g.
 *  "delivered" | "done"). */
export function outboxOutcome(
  ok: boolean,
  attempt: number,
  maxAttempts: number,
): "success" | "retry" | "dead" {
  if (ok) return "success";
  return isDeadLetter(attempt, maxAttempts) ? "dead" : "retry";
}

/** A raw claimed row (snake_case keys, as Postgres returns them). Each domain
 *  maps this to its own typed shape. */
export type OutboxRow = Record<string, unknown>;

/**
 * Atomically claim up to `limit` due rows (next_attempt_at <= DB now(), oldest
 * first): flip pending -> claimed via a CTE + FOR UPDATE SKIP LOCKED so a
 * concurrent worker never double-claims. Due is checked against the DB clock
 * (`now()`), never a JS timestamp, so sub-ms JS<->DB skew can't hide a just-due
 * row. Always returns the key, attempt-counter, and max_attempts columns; pass
 * `extraColumns` for any domain payload the worker needs (e.g. "payload",
 * "thread_id"). Rows come back raw (snake_case) for the caller to map.
 */
export async function claimDue(
  t: OutboxTable,
  limit: number,
  extraColumns: readonly string[] = [],
): Promise<OutboxRow[]> {
  const table = sql.identifier(t.table);
  const key = sql.identifier(t.key);
  const stateCol = sql.identifier(t.stateColumn);
  const returning = sql.join(
    [
      sql`o.${key}`,
      sql`o.${sql.identifier(t.attemptColumn)}`,
      sql`o.max_attempts`,
      ...extraColumns.map((c) => sql`o.${sql.identifier(c)}`),
    ],
    sql`, `,
  );
  return (await db.execute(sql`
    with due as (
      select ${key} from ${table}
      where ${stateCol} = ${t.pending} and next_attempt_at <= now()
      order by next_attempt_at asc
      limit ${limit}
      for update skip locked
    )
    update ${table} o set ${stateCol} = ${t.claimed}, updated_at = now()
    from due where o.${key} = due.${key}
    returning ${returning}`)) as unknown as OutboxRow[];
}

/** Mark a claimed row terminal-success (`successState`) and clear last_error. */
export async function markSuccess(t: OutboxTable, key: string, successState: string): Promise<void> {
  await db.execute(sql`
    update ${sql.identifier(t.table)}
    set ${sql.identifier(t.stateColumn)} = ${successState}, last_error = null, updated_at = now()
    where ${sql.identifier(t.key)} = ${key}`);
}

/** Schedule a claimed row for retry: back to pending, increment the attempt
 *  counter, set next_attempt_at, record a bounded last_error. */
export async function markForRetry(
  t: OutboxTable,
  key: string,
  nextAttemptAt: Date,
  lastError: string,
): Promise<void> {
  const attemptCol = sql.identifier(t.attemptColumn);
  await db.execute(sql`
    update ${sql.identifier(t.table)}
    set ${sql.identifier(t.stateColumn)} = ${t.pending},
        ${attemptCol} = ${attemptCol} + 1,
        next_attempt_at = ${nextAttemptAt.toISOString()}::timestamptz,
        last_error = ${lastError.slice(0, 500)},
        updated_at = now()
    where ${sql.identifier(t.key)} = ${key}`);
}

/** Dead-letter a claimed row: terminal `dead`, increment the attempt counter,
 *  record a bounded last_error. Pass `reschedule` to ALSO write next_attempt_at
 *  on the dead path (canonicalization does; capture/learning leave it). */
export async function markDead(
  t: OutboxTable,
  key: string,
  lastError: string,
  reschedule?: Date,
): Promise<void> {
  const attemptCol = sql.identifier(t.attemptColumn);
  await db.execute(sql`
    update ${sql.identifier(t.table)}
    set ${sql.identifier(t.stateColumn)} = ${t.dead},
        ${attemptCol} = ${attemptCol} + 1,
        ${reschedule ? sql`next_attempt_at = ${reschedule.toISOString()}::timestamptz,` : sql``}
        last_error = ${lastError.slice(0, 500)},
        updated_at = now()
    where ${sql.identifier(t.key)} = ${key}`);
}

/** Boot recovery: flip rows orphaned in the `claimed` (in-flight) state back to
 *  pending so they are re-claimed. Returns the count reset. NOT for at-most-once
 *  queues (memory-capture never auto-resets a crashed `delivering` row). */
export async function resetStuck(t: OutboxTable): Promise<number> {
  const rows = (await db.execute(sql`
    update ${sql.identifier(t.table)} set ${sql.identifier(t.stateColumn)} = ${t.pending}, updated_at = now()
    where ${sql.identifier(t.stateColumn)} = ${t.claimed}
    returning ${sql.identifier(t.key)}`)) as unknown as unknown[];
  return rows.length;
}
