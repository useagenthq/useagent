import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, type Executor } from "../../db/client";
import { slackOutbox, type SlackErrorClass } from "../../db/schema";
import type { SlackOutboxEnqueue } from "./types";

// ---------------------------------------------------------------------------
// Slack outbox persistence — pure data access. Delivery decisions live in
// delivery.ts; this only reads/writes rows.
// ---------------------------------------------------------------------------

const PAYLOAD_CAP = 48_000;
/** Appended to the last kept chunk when trailing chunks had to be dropped. */
const TRUNCATION_MARKER = "\n\n_(truncated; full reply in the app)_";

export type SlackOutboxRow = typeof slackOutbox.$inferSelect;

/** The subset of a claimed row the delivery worker needs. Mapped explicitly from
 *  the raw `db.execute` result, whose keys are snake_case (NOT drizzle's
 *  camelCase) — a straight cast would silently yield `undefined` numeric fields. */
export interface ClaimedRow {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly kind: SlackOutboxRow["kind"];
  readonly state: SlackOutboxRow["state"];
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
  const scope = entry.payload as { teamId?: unknown; orgId?: unknown };
  if (
    typeof scope.teamId === "string" &&
    scope.teamId.length > 0 &&
    !(typeof scope.orgId === "string" && scope.orgId.length > 0)
  ) {
    throw new Error("team-scoped Slack outbox rows require enqueue-time orgId");
  }
  // Bound the payload at the FIELD level, never by slicing serialized JSON -
  // a byte-slice cut a production reply mid-string (8,978-char summary ->
  // exactly 8,192 stored, unparseable, permanently dead-lettered as
  // invalid_payload). A chunked post_message sheds WHOLE trailing chunks (with
  // an honest marker on the last kept one) until the row fits; a payload that
  // is still oversized after that is a programming error and refuses loudly
  // instead of corrupting.
  const bounded: Record<string, unknown> = { ...(entry.payload as Record<string, unknown>) };
  // Shed WHOLE trailing chunks (never a byte-slice) from whichever TEXT chunk
  // field this kind carries: `chunks` (post_message) or `fallbackChunks` (the
  // plain-text fallback on card/stream rows). Stream rows carry OBJECT chunk
  // arrays under `chunks` - those are size-capped at build time and must never
  // enter the string shedder. The Block Kit `blocks` are already length-capped
  // by the pure card builder, so only the free-text answer can overflow.
  const textChunks = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((c) => typeof c === "string");
  const chunkField = textChunks(bounded.chunks)
    ? "chunks"
    : textChunks(bounded.fallbackChunks)
      ? "fallbackChunks"
      : null;
  if (chunkField) {
    let chunks = bounded[chunkField] as string[];
    let dropped = false;
    while (chunks.length > 1 && JSON.stringify({ ...bounded, [chunkField]: chunks }).length > PAYLOAD_CAP) {
      chunks = chunks.slice(0, -1);
      dropped = true;
    }
    if (dropped) {
      chunks = chunks.with(-1, chunks.at(-1)!.replace(/\n\n_\(continued…\)_$/, "") + TRUNCATION_MARKER);
    }
    bounded[chunkField] = chunks;
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
    returning o.id, o.idempotency_key, o.kind, o.state, o.payload, o.attempt_count, o.max_attempts`)) as unknown as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: r.id as string,
    idempotencyKey: r.idempotency_key as string,
    kind: r.kind as ClaimedRow["kind"],
    state: r.state as ClaimedRow["state"],
    payload: r.payload as string,
    attemptCount: Number(r.attempt_count),
    maxAttempts: Number(r.max_attempts),
  }));
}

/** Persist delivery progress on a claimed row (the chunk cursor): after each
 *  posted chunk the remaining ones are written back, so a mid-sequence retry
 *  resumes at the failed chunk instead of re-posting delivered ones. */
export async function updatePayload(id: string, payload: string): Promise<void> {
  await db.update(slackOutbox).set({ payload, updatedAt: new Date() }).where(eq(slackOutbox.id, id));
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

/** Terminal Slack rows that still owe a durable user-visible receipt. Upload
 * success and every run-scoped dead letter are reconstructed from the row's
 * immutable payload/error fields; event ids make replay idempotent. */
export async function listPendingSlackReceipts(limit = 20): Promise<ClaimedRow[]> {
  const rows = await db
    .select()
    .from(slackOutbox)
    .where(and(
      isNull(slackOutbox.receiptEmittedAt),
      or(
        eq(slackOutbox.state, "dead"),
        and(eq(slackOutbox.state, "delivered"), eq(slackOutbox.kind, "upload_file")),
      ),
    ))
    .orderBy(slackOutbox.updatedAt, slackOutbox.id)
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    kind: row.kind,
    state: row.state,
    payload: row.payload,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
  }));
}

export async function markSlackReceiptEmitted(id: string): Promise<void> {
  await db
    .update(slackOutbox)
    .set({ receiptEmittedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(slackOutbox.id, id), isNull(slackOutbox.receiptEmittedAt)));
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

/** Rolling-upgrade repair for rows enqueued before team-scoped payloads carried
 * orgId. Recover authority only from durable product ownership (run, artifact,
 * or linked Slack thread), never from the workspace's current mutable binding. */
export async function backfillSlackOutboxOrgScope(): Promise<number> {
  const candidates = await db
    .select({ id: slackOutbox.id, payload: slackOutbox.payload })
    .from(slackOutbox)
    .where(sql`${slackOutbox.state} in ('pending', 'delivering')`);
  for (const row of candidates) {
    try {
      JSON.parse(row.payload);
    } catch {
      await markDead(row.id, {
        errorClass: "permanent",
        lastError: "invalid_payload",
      });
    }
  }
  const fromRuns = await db.execute(sql`
    update slack_outbox o
    set payload = jsonb_set(o.payload::jsonb, '{orgId}', to_jsonb(r.org_id), true)::text,
        updated_at = now()
    from runs r
    where o.state in ('pending', 'delivering')
      and o.payload::jsonb ? 'teamId'
      and not (o.payload::jsonb ? 'orgId')
      and coalesce(
        o.payload::jsonb->>'runId',
        o.payload::jsonb->>'rootRunId',
        o.payload::jsonb->>'deliveryRunId'
      ) = r.id
      and r.org_id is not null
    returning o.id`);
  const fromArtifacts = await db.execute(sql`
    update slack_outbox o
    set payload = jsonb_set(o.payload::jsonb, '{orgId}', to_jsonb(a.org_id), true)::text,
        updated_at = now()
    from artifacts a
    where o.state in ('pending', 'delivering')
      and o.payload::jsonb ? 'teamId'
      and not (o.payload::jsonb ? 'orgId')
      and o.payload::jsonb->>'artifactId' = a.id::text
    returning o.id`);
  const fromThreads = await db.execute(sql`
    update slack_outbox o
    set payload = jsonb_set(o.payload::jsonb, '{orgId}', to_jsonb(st.org_id), true)::text,
        updated_at = now()
    from slack_threads st
    where o.state in ('pending', 'delivering')
      and o.payload::jsonb ? 'teamId'
      and not (o.payload::jsonb ? 'orgId')
      and o.payload::jsonb->>'teamId' = st.team_id
      and o.payload::jsonb->>'channel' = st.channel
      and o.payload::jsonb->>'threadTs' = st.thread_ts
    returning o.id`);
  return fromRuns.length + fromArtifacts.length + fromThreads.length;
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
