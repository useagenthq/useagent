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

// ---------------------------------------------------------------------------
// Capture-quality contract. A capture write that still fails after the bounded retry
// below is a LOST frame: the run's native history is missing something the provider
// emitted. The loss goes into a per-run ledger - in memory at once, and durably in
// run_capture_loss on a best-effort write that is retried whenever the ledger is read -
// and the canonicalization outbox seals such a run as `complete_degraded`, never
// `complete`, so no reader can mistake a shorter history for the whole one. Required
// captures are excluded: their failure is returned to the caller, who retries or fails
// the run loudly. The memory copy is process-local (single-replica scope, like the drain
// barrier) and only bridges the gap until the durable row lands.
// ---------------------------------------------------------------------------

/** Delays before the second and third attempt of a failed capture write. */
const CAPTURE_RETRY_DELAYS_MS = [100, 400] as const;

interface CaptureLossEntry {
  threadId: string;
  /** Lost frames not yet counted in the durable row. */
  pending: number;
  lastError: string;
  flushing: Promise<void> | null;
}
const captureLosses = new Map<string, CaptureLossEntry>();

export interface CaptureLoss {
  readonly lostFrames: number;
  readonly lastError: string | null;
}

async function persistWithRetry(input: ProviderEventInput, seq: RunSequencer): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await persistAndPublish(input, seq);
      return;
    } catch (err) {
      const delay = CAPTURE_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw err;
      console.warn(
        `[provider-events] capture attempt ${attempt + 1} failed (${input.eventType}); retrying in ${delay}ms:`,
        errorMessage(err),
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function noteCaptureLoss(input: ProviderEventInput, error: string): void {
  const entry = captureLosses.get(input.runId) ?? {
    threadId: input.threadId, pending: 0, lastError: error, flushing: null,
  };
  entry.pending++;
  entry.lastError = error;
  captureLosses.set(input.runId, entry);
  console.error(
    `[provider-events] LOST frame for run ${input.runId} (${input.eventType}); the run will seal as complete_degraded:`,
    error,
  );
  void flushCaptureLoss(input.runId).catch(() => {});
}

/** Push the in-memory loss count into run_capture_loss. One flush in flight per run; a
 *  loss noted during a flush is carried by the next one. Rejects when the write fails,
 *  and the memory copy then keeps the count until a later flush lands. */
function flushCaptureLoss(runId: string): Promise<void> {
  const entry = captureLosses.get(runId);
  if (!entry || entry.pending === 0) return Promise.resolve();
  if (entry.flushing) return entry.flushing;
  const n = entry.pending;
  const flush = db
    .execute(sql`
      insert into run_capture_loss (run_id, thread_id, lost_frames, last_error)
      values (${runId}, ${entry.threadId}, ${n}, ${entry.lastError.slice(0, 500)})
      on conflict (run_id) do update set
        lost_frames = run_capture_loss.lost_frames + excluded.lost_frames,
        last_error = excluded.last_error,
        last_at = now()`)
    .then(() => {
      entry.pending -= n;
      if (entry.pending === 0) captureLosses.delete(runId);
    })
    .finally(() => {
      entry.flushing = null;
    });
  entry.flushing = flush;
  return flush;
}

/** The run's capture loss as the seal sees it: the durable row plus anything still only
 *  in memory, after one more attempt to land it. Null when nothing was lost. */
export async function captureLossForRun(runId: string): Promise<CaptureLoss | null> {
  await flushCaptureLoss(runId).catch(() => {});
  const [row] = (await db.execute(sql`
    select lost_frames, last_error from run_capture_loss where run_id = ${runId}`)) as unknown as Array<{
    lost_frames: number | string; last_error: string | null;
  }>;
  const pending = captureLosses.get(runId);
  const lostFrames = Number(row?.lost_frames ?? 0) + (pending?.pending ?? 0);
  if (lostFrames === 0) return null;
  return { lostFrames, lastError: pending?.lastError ?? row?.last_error ?? null };
}

/** Tests only: forget the in-memory ledger, as a process restart would. */
export function resetCaptureLossMemoryForTest(): void {
  captureLosses.clear();
}

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
 * usable for later events. Every write gets the bounded retry; a write that still
 * fails and was not `required` is counted as a lost frame (see the capture-quality
 * contract above), so the run seals degraded instead of claiming completeness.
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
  const attempt = entry.chain.then(() => persistWithRetry(input, entry));
  const done = attempt.catch((err) => {
      const msg = errorMessage(err);
      // The chain must stay resolved (a rejected link stalls the run's later captures), so
      // failures are logged, not thrown. `critical` raises the level so an authoritative frame
      // (a command catalog) fails VISIBLY instead of being silently dropped.
      if (opts.critical) console.error(`[provider-events] CRITICAL capture failed (${input.eventType}):`, msg);
      else console.warn("[provider-events] capture failed:", msg);
      // A required capture hands its failure to the caller, who retries or fails the run.
      // Anything else is a LOST frame: record it so the run seals degraded, never complete.
      if (!opts.required) noteCaptureLoss(input, msg);
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

/**
 * Immutable lifecycle capture: insert the stable event exactly once and report
 * whether this caller won the insert. Unlike recordProviderEvent, a retry never
 * revises or re-publishes an existing row. Persistence failures propagate to the
 * caller while the shared per-run chain remains usable for a later repair retry.
 */
export function recordProviderEventIfAbsent(
  input: ProviderEventInput,
): Promise<boolean> {
  let seq = runSequencers.get(input.runId);
  if (!seq) {
    seq = { chain: Promise.resolve(), nextSeq: null };
    runSequencers.set(input.runId, seq);
  }
  const entry = seq;
  const attempt = entry.chain.then(() => persistAndPublishIfAbsent(input, entry));
  const done = attempt.then(() => undefined).catch((err) => {
    console.error(
      `[provider-events] CRITICAL immutable capture failed (${input.eventType}):`,
      errorMessage(err),
    );
  });
  entry.chain = done;
  void done.finally(() => {
    if (runSequencers.get(input.runId) === entry && entry.chain === done) {
      runSequencers.delete(input.runId);
    }
  });
  return attempt;
}

async function persistAndPublishIfAbsent(
  input: ProviderEventInput,
  seq: RunSequencer,
): Promise<boolean> {
  if (seq.nextSeq === null) seq.nextSeq = (await highestSeq(input.runId)) + 1;
  const assignedSeq = seq.nextSeq++;

  let payload: string | null = null;
  if (input.payload !== undefined) {
    payload = serializeProviderPayload(input.payload, providerPayloadCapBytes(input));
  }
  const inserted = await db
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
    .onConflictDoNothing({ target: providerEvents.id })
    .returning({ id: providerEvents.id });

  if (inserted.length === 0) return false;

  if (executionGraphWriteEnabled()) {
    await shadowWriteExecutionGraph(input, assignedSeq);
  }

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
  return true;
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
