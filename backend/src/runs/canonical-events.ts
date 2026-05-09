/**
 * Canonical agent-event lane persistence (final_harness Phase 1, slice 3).
 *
 * The durable home of the provider-neutral canonical events (src/engines/canonical.ts).
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
import { db } from "../db/client";
import { canonicalEvents } from "../db/schema";
import { CANONICAL_SCHEMA_VERSION, type CanonicalAgentEvent } from "../engines/canonical";
import { getNativeFramesSince } from "./native-events";
import { getStepsApi } from "./repo";
import { translateOpenCode, type OpenCodeFrame, type OpenCodeStep } from "../engines/opencode-canonical";

/** A persisted canonical event: the canonical event + its immutable thread delivery
 *  cursor and revision. This is what SSE delivers and replay returns. */
export type DeliveredCanonicalEvent = CanonicalAgentEvent & {
  readonly deliverySeq: number;
  readonly revision: number;
};

const bus = new EventEmitter();
bus.setMaxListeners(0);
export const canonicalThreadChannel = (threadId: string): string => `canonical-thread:${threadId}`;

/** Subscribe to a THREAD's live canonical events (all runs, incl. later ones). */
export function subscribeCanonicalThread(
  threadId: string,
  fn: (e: DeliveredCanonicalEvent) => void,
): () => void {
  const ch = canonicalThreadChannel(threadId);
  bus.on(ch, fn);
  return () => bus.off(ch, fn);
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

/** PERSIST-BEFORE-SSE: append durably, and ONLY after the write resolves, publish to
 *  the THREAD channel so live subscribers and replay serve the SAME rows/cursors. */
export async function persistAndPublish(
  events: readonly CanonicalAgentEvent[],
): Promise<DeliveredCanonicalEvent[]> {
  const delivered = await persistCanonicalEvents(events);
  for (const d of delivered) bus.emit(canonicalThreadChannel(d.threadId), d);
  return delivered;
}

/** Translate a settled OpenCode run's native frames + durable steps into canonical
 *  events and persist+publish them ALONGSIDE the native lane (slice 3b). Idempotent:
 *  a no-op if the run already has canonical rows (finalizeRun may run more than once).
 *  Best-effort - the caller must never let a failure here affect the run. */
export async function translateAndPersistRun(runId: string, threadId: string): Promise<number> {
  const [already] = await db
    .select({ id: canonicalEvents.deliverySeq })
    .from(canonicalEvents)
    .where(eq(canonicalEvents.runId, runId))
    .limit(1);
  if (already) return 0; // already translated - don't append duplicate revisions

  const [frames, steps] = await Promise.all([getNativeFramesSince(runId, -1), getStepsApi(runId)]);
  if (frames.length === 0 && steps.length === 0) return 0;
  const { events } = translateOpenCode(
    frames as unknown as OpenCodeFrame[],
    { runId, threadId },
    steps as unknown as OpenCodeStep[],
  );
  if (events.length === 0) return 0;
  const delivered = await persistAndPublish(events);
  return delivered.length;
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
