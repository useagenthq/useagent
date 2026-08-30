import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { providerEvents } from "../db/schema";
import { makeNativeFrame, publishNativeFrame } from "./native-events";
import { errorMessage } from "../util/error-message";
import { executionGraphWriteEnabled } from "./execution-graph-rollout";
import { shadowWriteExecutionGraph } from "./execution-graph-shadow-writer";

export const PROVIDER_PAYLOAD_CAP_BYTES = 32 * 1_024;
export const CHILD_TRANSCRIPT_PAYLOAD_CAP_BYTES = 512 * 1_024;
const textEncoder = new TextEncoder();

export function serializeProviderPayload(
  value: unknown,
  capBytes = PROVIDER_PAYLOAD_CAP_BYTES,
): string | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    const bytes = textEncoder.encode(serialized).byteLength;
    if (bytes <= capBytes) return serialized;
    return JSON.stringify({
      _truncated: true,
      _original_bytes: bytes,
      _reason: "provider payload exceeded durable byte limit",
    });
  } catch {
    return null;
  }
}

export type ProviderEventInput = {
  /** Stable id — one row per native part (revisions upsert) or lifecycle key. */
  id: string;
  runId: string;
  threadId: string;
  provider: string;
  eventType: string;
  nativeSessionId?: string | null;
  nativeParentSessionId?: string | null;
  nativeMessageId?: string | null;
  nativePartId?: string | null;
  nativeCallId?: string | null;
  payload?: unknown;
};

export function providerPayloadCapBytes(
  input: Pick<ProviderEventInput,
    | "eventType"
    | "nativeSessionId"
    | "nativeParentSessionId"
    | "nativeMessageId"
  >,
): number {
  return input.eventType.startsWith("t3.activity.child.message.") &&
      !!input.nativeSessionId &&
      !!input.nativeParentSessionId &&
      !!input.nativeMessageId
    ? CHILD_TRANSCRIPT_PAYLOAD_CAP_BYTES
    : PROVIDER_PAYLOAD_CAP_BYTES;
}

/** Namespace provider-native event ids by run before using the global row key. */
export function scopedProviderEventId(runId: string, eventId: string): string {
  const prefix = `${runId}:`;
  return eventId.startsWith(prefix) ? eventId : `${prefix}${eventId}`;
}

// ---------------------------------------------------------------------------
// Per-run native-frame SEQUENCER — the invariant the reconnect cursor depends on.
//
// The client's SSE reconnect sends `?cursor=<highest seq seen>` and the server
// replays `seq > cursor` (native-events.getNativeFramesSince). That is lossless
// ONLY if, for every run, the live lane assigns a UNIQUE, MONOTONIC seq and
// PUBLISHES frames in ascending seq order — otherwise "highest seq seen" is not a
// safe low-water mark and a lower seq is skipped forever on reconnect.
//
// Two ways that invariant used to break (the GAP-1 loss window):
//   1. NON-UNIQUE seq — two independent emitters minted seq 0 for the same run
//      (opencode capture started its counter at 0; the retrieval ledger hard-coded
//      seq 0). A cursor of 0 then skipped the OTHER row that shared it.
//   2. OUT-OF-ORDER publish — captures were fire-and-forget (`void
//      recordProviderEvent`), so their durable insert+publish resolved in DB-
//      latency order, not call order. A client that advanced its cursor to a
//      higher seq lost a lower seq delivered late when the socket dropped between.
//
// Fix: a single per-run counter mints the seq (unique + monotonic across ALL
// emitters), and a per-run serial chain runs persist→publish in call order so the
// lane is strictly ascending. The counter is seeded lazily from the DB max (so a
// re-created entry after idle eviction never resets), and the entry is evicted
// once its chain goes idle so the map stays bounded.
// ---------------------------------------------------------------------------

interface RunSequencer {
  /** Serial chain: each capture runs after the previous, so publishes are ordered. */
  chain: Promise<void>;
  /** Next seq to mint; null until seeded from the DB max on the first capture. */
  nextSeq: number | null;
}

const runSequencers = new Map<string, RunSequencer>();

/**
 * Drain/seal barrier: await every provider-event write CURRENTLY in flight for a run.
 * Captures are fire-and-forget (`void recordProviderEvent`), so at the moment the
 * canonicalization outbox reads the source watermark a queued write may not have
 * committed yet - it would then commit AFTER both watermark reads and be silently
 * missed. Awaiting the run's serial chain here forces those in-flight writes to commit
 * before the `before` watermark is taken; the `after` re-read still catches anything that
 * arrives during the translate. For a SETTLED run no new captures start, so one drain
 * seals the source. Process-local (single-replica scope, documented); resolves
 * immediately when the run has no in-flight chain.
 */
export async function drainProviderEvents(runId: string): Promise<void> {
  const entry = runSequencers.get(runId);
  if (!entry) return;
  try {
    await entry.chain;
  } catch {
    /* chain failures are already swallowed+logged by recordProviderEvent */
  }
}

/** Whether a provider event with this stable id is durably persisted. Used by strict/critical
 *  callers (command catalogs) to verify a capture landed and retry the idempotent upsert if the
 *  serial chain swallowed a failure. */
export async function providerEventExists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: providerEvents.id })
    .from(providerEvents)
    .where(eq(providerEvents.id, id))
    .limit(1);
  return !!row;
}

/** Highest seq already persisted for a run (−1 when none) — seeds the counter so
 *  a re-created sequencer continues the sequence instead of colliding. */
async function highestSeq(runId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${providerEvents.seq})` })
    .from(providerEvents)
    .where(eq(providerEvents.runId, runId));
  return row?.max ?? -1;
}

/**
 * Lossless-at-latest-revision capture: idempotent upsert by native identity, then
 * a live native frame published to SSE subscribers. Serialized per run and stamped
 * with a unique, monotonic seq (see the sequencer note above) so the reconnect
 * cursor never skips a frame. MUST never fail a run — the serial chain always stays
 * resolvable (a rejected link would stall every later capture for the run), so a
 * failure is caught + logged rather than propagated. Callers that AWAIT the returned
 * promise get persist-before-continue; pass `{ critical: true }` for an authoritative
 * frame (e.g. a command catalog) so a failure logs at ERROR level (visible), not just
 * a warning. The returned promise normally resolves once THIS event (and every
 * earlier one in the run's chain) has persisted or been logged-and-swallowed.
 * `{ required: true }` returns the unswallowed attempt to its authoritative
 * caller while the stored sequencer chain still catches the failure and remains
 * usable for later events.
 */
export function recordProviderEvent(
  input: ProviderEventInput,
  opts: { critical?: boolean; required?: boolean } = {},
): Promise<void> {
  let seq = runSequencers.get(input.runId);
  if (!seq) {
    seq = { chain: Promise.resolve(), nextSeq: null };
    runSequencers.set(input.runId, seq);
  }
  const entry = seq;
  const attempt = entry.chain.then(() => persistAndPublish(input, entry));
  const done = attempt.catch((err) => {
      const msg = errorMessage(err);
      // The chain must stay resolved (a rejected link stalls the run's later captures), so
      // failures are logged, not thrown. `critical` raises the level so an authoritative frame
      // (a command catalog) fails VISIBLY instead of being silently dropped.
      if (opts.critical) console.error(`[provider-events] CRITICAL capture failed (${input.eventType}):`, msg);
      else console.warn("[provider-events] capture failed:", msg);
  });
  entry.chain = done;
  // Idle-evict when this link is the tail and has settled, so the map only holds
  // runs with in-flight captures. A later event re-creates + re-seeds the entry.
  void done.finally(() => {
    if (runSequencers.get(input.runId) === entry && entry.chain === done) {
      runSequencers.delete(input.runId);
    }
  });
  return opts.required ? attempt : done;
}

async function persistAndPublish(input: ProviderEventInput, seq: RunSequencer): Promise<void> {
  if (seq.nextSeq === null) seq.nextSeq = (await highestSeq(input.runId)) + 1;
  const assignedSeq = seq.nextSeq++;

  let payload: string | null = null;
  if (input.payload !== undefined) {
    payload = serializeProviderPayload(input.payload, providerPayloadCapBytes(input));
  }
  await db
    .insert(providerEvents)
    .values({
      id: input.id,
      runId: input.runId,
      threadId: input.threadId,
      seq: assignedSeq,
      provider: input.provider,
      eventType: input.eventType,
      nativeSessionId: input.nativeSessionId ?? null,
      nativeParentSessionId: input.nativeParentSessionId ?? null,
      nativeMessageId: input.nativeMessageId ?? null,
      nativePartId: input.nativePartId ?? null,
      nativeCallId: input.nativeCallId ?? null,
      payload,
    })
    .onConflictDoUpdate({
      target: providerEvents.id,
      set: {
        seq: assignedSeq,
        provider: input.provider,
        eventType: input.eventType,
        nativeSessionId: input.nativeSessionId ?? null,
        nativeParentSessionId: input.nativeParentSessionId ?? null,
        nativeMessageId: input.nativeMessageId ?? null,
        nativePartId: input.nativePartId ?? null,
        nativeCallId: input.nativeCallId ?? null,
        payload,
        createdAt: sql`now()`,
      },
      // A revision always mints a HIGHER seq (the counter only grows), so this
      // guard is normally true; it stays as defense against a stale write ever
      // arriving after a re-seeded counter.
      setWhere: sql`${providerEvents.seq} < ${assignedSeq}`,
    });

  // Graph writes are additive and fail-open. They happen only after the native
  // event is durable and before live publication, preserving one observed order.
  if (executionGraphWriteEnabled()) {
    await shadowWriteExecutionGraph(input, assignedSeq);
  }

  // Live-push the versioned native frame to any SSE subscriber (north star
  // "Canonical Events"). AFTER the persist, so a subscriber never sees a frame
  // that isn't durable; and inside the serial chain, so frames go out in ascending
  // seq order — the guarantee the reconnect cursor relies on.
  publishNativeFrame(
    input.runId,
    makeNativeFrame({
      eventId: input.id,
      seq: assignedSeq,
      provider: input.provider,
      eventType: input.eventType,
      sessionId: input.nativeSessionId ?? null,
      parentSessionId: input.nativeParentSessionId ?? null,
      messageId: input.nativeMessageId ?? null,
      partId: input.nativePartId ?? null,
      callId: input.nativeCallId ?? null,
      payloadText: payload,
    }),
  );
}
