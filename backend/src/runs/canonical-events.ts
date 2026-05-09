/**
 * Canonical agent-event lane persistence (final_harness Phase 1, slice 3).
 *
 * The durable home of the provider-neutral canonical events (src/engines/canonical.ts).
 * The key invariant: PERSIST BEFORE PUBLISH - a canonical event is written to
 * `canonical_events` and only THEN emitted to live SSE subscribers, so a reconnect/
 * reload replays the SAME rows the live stream showed (no lost or divergent events).
 * Runs ALONGSIDE the native lane (provider_events); additive, not a replacement.
 * `eventId` is stable per (run, native event) so a revision UPSERTS (idempotent replay).
 */
import { EventEmitter } from "node:events";
import { and, asc, eq, gt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { canonicalEvents } from "../db/schema";
import { CANONICAL_SCHEMA_VERSION, type CanonicalAgentEvent } from "../engines/canonical";

const bus = new EventEmitter();
bus.setMaxListeners(0);
export const canonicalChannel = (runId: string): string => `canonical:${runId}`;

/** Subscribe to a run's live canonical events. Returns an unsubscribe fn. */
export function subscribeCanonical(runId: string, fn: (e: CanonicalAgentEvent) => void): () => void {
  const ch = canonicalChannel(runId);
  bus.on(ch, fn);
  return () => bus.off(ch, fn);
}

type Row = typeof canonicalEvents.$inferInsert;

function toRow(e: CanonicalAgentEvent): Row {
  const { schemaVersion: _sv, eventId, seq, runId, threadId, turnId, ts, identity, ...body } = e;
  return {
    eventId,
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

function rowToEvent(r: typeof canonicalEvents.$inferSelect): CanonicalAgentEvent {
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
  } as CanonicalAgentEvent;
}

/** Durably persist canonical events (idempotent upsert on eventId; a revision keeps
 *  the latest seq/ts/body). Does NOT publish - callers use persistAndPublish so the
 *  persist-before-publish ordering is explicit. */
export async function persistCanonicalEvents(events: readonly CanonicalAgentEvent[]): Promise<void> {
  if (events.length === 0) return;
  await db
    .insert(canonicalEvents)
    .values(events.map(toRow))
    .onConflictDoUpdate({
      target: canonicalEvents.eventId,
      set: {
        seq: sql`excluded.seq`,
        ts: sql`excluded.ts`,
        kind: sql`excluded.kind`,
        identity: sql`excluded.identity`,
        body: sql`excluded.body`,
      },
    });
}

/** PERSIST-BEFORE-SSE: write the events durably, and ONLY after the write resolves,
 *  publish them to live subscribers. Replay (loadCanonicalThread) and live therefore
 *  serve the SAME rows. */
export async function persistAndPublish(events: readonly CanonicalAgentEvent[]): Promise<void> {
  await persistCanonicalEvents(events);
  for (const e of events) bus.emit(canonicalChannel(e.runId), e);
}

/** Replay a thread's canonical events after a cursor (for reconnect/reload). */
export async function loadCanonicalThread(threadId: string, afterSeq = -1): Promise<CanonicalAgentEvent[]> {
  const rows = await db
    .select()
    .from(canonicalEvents)
    .where(and(eq(canonicalEvents.threadId, threadId), gt(canonicalEvents.seq, afterSeq)))
    .orderBy(asc(canonicalEvents.seq));
  return rows.map(rowToEvent);
}

/** Replay a single run's canonical events after a cursor. */
export async function loadCanonicalRun(runId: string, afterSeq = -1): Promise<CanonicalAgentEvent[]> {
  const rows = await db
    .select()
    .from(canonicalEvents)
    .where(and(eq(canonicalEvents.runId, runId), gt(canonicalEvents.seq, afterSeq)))
    .orderBy(asc(canonicalEvents.seq));
  return rows.map(rowToEvent);
}
