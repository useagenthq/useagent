/**
 * Canonical agent-event lane persistence.
 *
 * The durable home of the provider-neutral canonical events (@useagent/agent-harness/canonical).
 * Invariants:
 *  - PERSIST BEFORE PUBLISH: an event is written to `canonical_events` and only THEN
 *    emitted to live subscribers, so a reconnect replays the SAME rows live showed.
 *  - IMMUTABLE THREAD-WIDE DELIVERY CURSOR: `deliverySeq` (bigserial) only increases;
 *    a later run in a thread always gets higher values than every earlier turn; the
 *    browser resumes with "everything after N". It is NEVER mutated/reordered.
 *  - APPEND-ONLY REVISIONS: a re-emitted `eventId` inserts a NEW row (higher revision
 *    + higher deliverySeq); downstream keeps the latest revision per eventId. The
 *    per-run/source order lives in `seq`, kept separate from the delivery cursor.
 *  - THREAD CHANNEL: publish/subscribe per THREAD (not only per run), so a subscriber
 *    receives events from every run in the thread, including runs created later.
 * Runs ALONGSIDE the native lane; additive.
 */
import { EventEmitter } from "node:events";
import { and, asc, eq, gt, inArray, max } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { canonicalEvents } from "../db/schema";
import { CANONICAL_SCHEMA_VERSION, type CanonicalAgentEvent } from "@useagent/agent-harness/canonical";

/** A persisted canonical event: the canonical event + its immutable thread delivery
 *  cursor and revision. This is what SSE delivers and replay returns. */
export type DeliveredCanonicalEvent = CanonicalAgentEvent & {
  readonly deliverySeq: number;
  readonly revision: number;
};

const bus = new EventEmitter();
bus.setMaxListeners(0);
export const canonicalThreadChannel = (threadId: string): string => `canonical-thread:${threadId}`;
const canonicalCompleteChannel = (threadId: string): string => `canonical-complete:${threadId}`;

/** The durable "this run's canonicalization is COMPLETE" signal (H2). Carries the
 *  source watermark it locked in. React trusts the canonical lane for a run ONLY once
 *  this arrives (replay from the outbox on reconnect, live on completion) - never on
 *  the mere presence of provisional rows. */
export interface CanonicalizationComplete {
  readonly runId: string;
  readonly threadId: string;
  readonly sourceFrameMax: number;
  readonly sourceStepCount: number;
}

/** Subscribe to a THREAD's live canonical events (all runs, incl. later ones). */
export function subscribeCanonicalThread(
  threadId: string,
  fn: (e: DeliveredCanonicalEvent) => void,
): () => void {
  const ch = canonicalThreadChannel(threadId);
  bus.on(ch, fn);
  return () => bus.off(ch, fn);
}

/** Subscribe to a THREAD's live canonicalization-complete signals (one per run as its
 *  outbox row reaches `complete`). */
export function subscribeCanonicalizationComplete(
  threadId: string,
  fn: (e: CanonicalizationComplete) => void,
): () => void {
  const ch = canonicalCompleteChannel(threadId);
  bus.on(ch, fn);
  return () => bus.off(ch, fn);
}

/** Publish a run's canonicalization-complete signal to its thread channel. Called by the
 *  outbox worker AFTER the `complete` row commits (durable-first), so a live client and a
 *  reconnecting client converge on the same truth. */
export function publishCanonicalizationComplete(e: CanonicalizationComplete): void {
  bus.emit(canonicalCompleteChannel(e.threadId), e);
}

type SelectRow = typeof canonicalEvents.$inferSelect;

function toInsertRow(e: CanonicalAgentEvent, revision: number) {
  const { schemaVersion: _sv, eventId, seq, runId, threadId, turnId, ts, identity, ...body } = e;
  return {
    eventId,
    revision,
    runId,
    threadId,
    seq,
    turnId: turnId ?? null,
    kind: e.kind,
    ts,
    identity: identity as unknown as Record<string, unknown>,
    body: body as unknown as Record<string, unknown>,
  };
}

function rowToDelivered(r: SelectRow): DeliveredCanonicalEvent {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    eventId: r.eventId,
    seq: r.seq,
    runId: r.runId,
    threadId: r.threadId,
    ts: r.ts,
    identity: r.identity as unknown as CanonicalAgentEvent["identity"],
    ...(r.turnId ? { turnId: r.turnId } : {}),
    ...(r.body as object),
    deliverySeq: r.deliverySeq,
    revision: r.revision,
  } as DeliveredCanonicalEvent;
}

/** Append canonical events durably (never mutates a delivered cursor): each event is
 *  a NEW row with an auto-assigned deliverySeq; a re-emitted eventId gets the next
 *  revision. Returns the delivered rows (with their assigned deliverySeq). */
export async function persistCanonicalEvents(
  events: readonly CanonicalAgentEvent[],
): Promise<DeliveredCanonicalEvent[]> {
  if (events.length === 0) return [];
  const ids = [...new Set(events.map((e) => e.eventId))];
  const existing = await db
    .select({ eventId: canonicalEvents.eventId, rev: max(canonicalEvents.revision) })
    .from(canonicalEvents)
    .where(inArray(canonicalEvents.eventId, ids))
    .groupBy(canonicalEvents.eventId);
  const nextRev = new Map<string, number>(existing.map((r) => [r.eventId, (r.rev ?? -1) + 1]));
  const rows = events.map((e) => {
    const rev = nextRev.get(e.eventId) ?? 0;
    nextRev.set(e.eventId, rev + 1); // within-batch duplicate eventId (rare) still advances
    return toInsertRow(e, rev);
  });
  const inserted = await db.insert(canonicalEvents).values(rows).returning();
  return inserted.map(rowToDelivered);
}

/** Publish already-persisted events to their thread channel (persist-before-publish
 *  is the caller's responsibility). */
export function publishDelivered(delivered: readonly DeliveredCanonicalEvent[]): void {
  for (const d of delivered) bus.emit(canonicalThreadChannel(d.threadId), d);
}

/** PERSIST-BEFORE-SSE: append durably, and ONLY after the write resolves, publish to
 *  the THREAD channel so live subscribers and replay serve the SAME rows/cursors. */
export async function persistAndPublish(
  events: readonly CanonicalAgentEvent[],
): Promise<DeliveredCanonicalEvent[]> {
  const delivered = await persistCanonicalEvents(events);
  publishDelivered(delivered);
  return delivered;
}

/** REPLACE a run's canonical rows (delete + fresh insert, revision 0) using a GIVEN
 *  executor - so the caller can fold it into a larger transaction (the outbox writes the
 *  rows AND flips the completion record in ONE tx, so canonical rows only ever exist for
 *  a COMPLETE run; there are no provisional rows to go stale). */
export async function replaceCanonicalRowsTx(
  exec: Executor,
  runId: string,
  events: readonly CanonicalAgentEvent[],
): Promise<DeliveredCanonicalEvent[]> {
  await exec.delete(canonicalEvents).where(eq(canonicalEvents.runId, runId));
  if (events.length === 0) return [];
  const inserted = await exec.insert(canonicalEvents).values(events.map((e) => toInsertRow(e, 0))).returning();
  return inserted.map(rowToDelivered);
}

/** Replay a THREAD's canonical events after a delivery cursor (reconnect/reload).
 *  Returns rows in delivery order across ALL runs in the thread; the client keeps the
 *  latest revision per eventId. */
export async function loadCanonicalThread(
  threadId: string,
  afterDeliverySeq = 0,
): Promise<DeliveredCanonicalEvent[]> {
  const rows = await db
    .select()
    .from(canonicalEvents)
    .where(and(eq(canonicalEvents.threadId, threadId), gt(canonicalEvents.deliverySeq, afterDeliverySeq)))
    .orderBy(asc(canonicalEvents.deliverySeq));
  return rows.map(rowToDelivered);
}
