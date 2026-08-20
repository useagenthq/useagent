import { eq, sql } from "drizzle-orm";
import { db, type Executor } from "../../db/client";
import { slackOutbox, type SlackErrorClass } from "../../db/schema";
import type { SlackOutboxEnqueue } from "./types";

// ---------------------------------------------------------------------------
// Slack outbox persistence — pure data access. Delivery decisions live in
// delivery.ts; this only reads/writes rows.
// ---------------------------------------------------------------------------

const PAYLOAD_CAP = 8_192;
// Free-text cap leaves generous headroom for the JSON envelope and other fields.
const TEXT_FIELD_CAP = 7_000;

export type SlackOutboxRow = typeof slackOutbox.$inferSelect;

/** The subset of a claimed row the delivery worker needs. Mapped explicitly from
 *  the raw `db.execute` result, whose keys are snake_case (NOT drizzle's
 *  camelCase) — a straight cast would silently yield `undefined` numeric fields. */
export interface ClaimedRow {
  readonly id: string;
  readonly kind: SlackOutboxRow["kind"];
  readonly payload: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

/**
 * Idempotently enqueue an outbound Slack call (north star "transactional
 * connector outbox"): a committed row is the durable intent to deliver. A
 * duplicate idempotency key is a no-op, so the same logical message is enqueued
 * (and therefore delivered) at most once. Returns true if a NEW row was created.
 */
export async function enqueue(
  entry: SlackOutboxEnqueue,
  /** Enqueue inside a caller's transaction (run finalization commits the reply
   *  atomically with the run reaching terminal). Defaults to the shared pool. */
  exec: Executor = db,
): Promise<boolean> {
  // Bound the payload at the FIELD level, never by slicing serialized JSON -
  // a byte-slice cut a production reply mid-string (8,978-char summary ->
  // exactly 8,192 stored, unparseable, permanently dead-lettered as
  // invalid_payload). Only free-text fields are truncated (with an honest
  // marker); a payload that is still oversized after that is a programming
  // error and refuses loudly instead of corrupting.
  const bounded: Record<string, unknown> = { ...(entry.payload as Record<string, unknown>) };
  if (typeof bounded.text === "string" && bounded.text.length > TEXT_FIELD_CAP) {
    bounded.text = `${bounded.text.slice(0, TEXT_FIELD_CAP)}\n... (truncated; full reply in the app)`;
  }
  const payload = JSON.stringify(bounded);
  if (payload.length > PAYLOAD_CAP) {
    throw new Error(`slack outbox payload exceeds ${PAYLOAD_CAP} bytes after field bounding`);
  }
  const res = await exec
    .insert(slackOutbox)
    .values({
      id: crypto.randomUUID(),
      idempotencyKey: entry.idempotencyKey,
      kind: entry.kind,
      payload,
    })
    .onConflictDoNothing({ target: slackOutbox.idempotencyKey })
    .returning({ id: slackOutbox.id });
  return res.length > 0;
}

/**
 * Atomically claim up to `limit` due rows: pending with next_attempt_at <= now,
 * flipped to `delivering` so a concurrent worker can't double-send. FOR UPDATE
 * SKIP LOCKED keeps concurrent passes from blocking each other.
 */
export async function claimDue(limit = 20): Promise<ClaimedRow[]> {
  // CTE + UPDATE…FROM is the canonical SKIP LOCKED claim (FOR UPDATE isn't
  // allowed inside a WHERE id IN (subquery)). Due is checked against the DB clock
  // (`now()`), never a JS timestamp — otherwise sub-ms JS↔DB clock skew can make
  // a just-enqueued row look not-yet-due. Rows come back snake_case (raw), so map
  // explicitly to the camelCase ClaimedRow.
  const rows = (await db.execute(sql`
    with due as (
      select id from slack_outbox
      where state = 'pending' and next_attempt_at <= now()
      order by next_attempt_at asc
      limit ${limit}
      for update skip locked
    )
    update slack_outbox o set state = 'delivering', updated_at = now()
    from due where o.id = due.id
    returning o.id, o.kind, o.payload, o.attempt_count, o.max_attempts`)) as unknown as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as ClaimedRow["kind"],
    payload: r.payload as string,
    attemptCount: Number(r.attempt_count),
    maxAttempts: Number(r.max_attempts),
  }));
}

export async function markDelivered(id: string): Promise<void> {
  await db
    .update(slackOutbox)
    .set({ state: "delivered", lastError: null, errorClass: null, updatedAt: new Date() })
    .where(eq(slackOutbox.id, id));
}

export async function markRetry(
  id: string,
  info: { nextAttemptAt: Date; errorClass: SlackErrorClass; lastError: string },
): Promise<void> {
  await db
    .update(slackOutbox)
    .set({
      state: "pending",
      attemptCount: sql`${slackOutbox.attemptCount} + 1`,
      nextAttemptAt: info.nextAttemptAt,
      errorClass: info.errorClass,
      lastError: info.lastError.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(slackOutbox.id, id));
}

export async function markDead(
  id: string,
  info: { errorClass: SlackErrorClass; lastError: string },
): Promise<void> {
  await db
    .update(slackOutbox)
    .set({
      state: "dead",
      attemptCount: sql`${slackOutbox.attemptCount} + 1`,
      errorClass: info.errorClass,
      lastError: info.lastError.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(slackOutbox.id, id));
}

/**
 * Reset rows orphaned mid-delivery (claimed `delivering` then the process died)
 * back to `pending` so they redeliver on boot. This is at-least-once: a crash
 * AFTER Slack accepted but BEFORE markDelivered will redeliver (a duplicate) —
 * the north star's accepted trade (never claim exactly-once network delivery).
 * Returns the count reset.
 */
export async function resetStuckDelivering(): Promise<number> {
  const res = await db
    .update(slackOutbox)
    .set({ state: "pending", updatedAt: new Date() })
    .where(eq(slackOutbox.state, "delivering"))
    .returning({ id: slackOutbox.id });
  return res.length;
}

/** Test/ops read helpers. */
export async function getByKey(idempotencyKey: string): Promise<SlackOutboxRow | null> {
  const [row] = await db
    .select()
    .from(slackOutbox)
    .where(eq(slackOutbox.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}
