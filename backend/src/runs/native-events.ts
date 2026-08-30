import { EventEmitter } from "node:events";
import { and, asc, eq, gt } from "drizzle-orm";
import { NATIVE_SCHEMA_VERSION } from "@useagent/agent-client/wire";
import type { NativeFrame } from "@useagent/agent-client/wire";
import { db } from "../db/client";
import { providerEvents } from "../db/schema";

// ---------------------------------------------------------------------------
// Native-event streaming lane (north star "Canonical Events"): the versioned
// durable projection of the lossless provider_events capture, streamed to
// clients alongside — never replacing — the step/delta/done projection.
//
// Kept in its own module with a DEDICATED bus so the lossless native lane stays
// decoupled from the worker's step bus (and avoids an engines↔worker import
// cycle: provider-events → native-events → db, nothing back into worker).
// ---------------------------------------------------------------------------

// The native-event frame wire shape + schema version are the agent-client wire
// contract (shared verbatim with the browser client's parser); re-exported so
// backend callers keep importing them from here alongside the capture/replay
// machinery below. Bumping the version stays a backend concern (clients upcast).
export { NATIVE_SCHEMA_VERSION };
export type { NativeFrame };

type ProviderEventRow = typeof providerEvents.$inferSelect;

/** Live signal for newly-persisted native events, keyed per run. */
const nativeBus = new EventEmitter();
nativeBus.setMaxListeners(0);

export const nativeChannel = (runId: string): string => `native:${runId}`;

/** Subscribe to a run's live native frames. Returns an unsubscribe fn. */
export function subscribeNative(
  runId: string,
  fn: (frame: NativeFrame) => void,
): () => void {
  const ch = nativeChannel(runId);
  nativeBus.on(ch, fn);
  return () => nativeBus.off(ch, fn);
}

/** Publish a freshly-persisted native frame to live subscribers. */
export function publishNativeFrame(runId: string, frame: NativeFrame): void {
  nativeBus.emit(nativeChannel(runId), frame);
}

/** Parse a stored bounded payload. Legacy rows may contain invalid sliced JSON,
 *  so retain the compatibility marker instead of throwing. */
function parseStoredPayload(text: string | null): unknown {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _unparseable: true, _bytes: text.length };
  }
}

/** Build a frame from the fields written at capture time (live path). */
export function makeNativeFrame(fields: {
  eventId: string;
  seq: number;
  provider: string;
  eventType: string;
  sessionId: string | null;
  parentSessionId: string | null;
  messageId: string | null;
  partId: string | null;
  callId: string | null;
  payloadText: string | null;
}): NativeFrame {
  return {
    schemaVersion: NATIVE_SCHEMA_VERSION,
    eventId: fields.eventId,
    seq: fields.seq,
    provider: fields.provider,
    eventType: fields.eventType,
    native: {
      sessionId: fields.sessionId,
      parentSessionId: fields.parentSessionId,
      messageId: fields.messageId,
      partId: fields.partId,
      callId: fields.callId,
    },
    payload: parseStoredPayload(fields.payloadText),
  };
}

function rowToNativeFrame(row: ProviderEventRow): NativeFrame {
  return makeNativeFrame({
    eventId: row.id,
    seq: row.seq,
    provider: row.provider,
    eventType: row.eventType,
    sessionId: row.nativeSessionId,
    parentSessionId: row.nativeParentSessionId,
    messageId: row.nativeMessageId,
    partId: row.nativePartId,
    callId: row.nativeCallId,
    payloadText: row.payload,
  });
}

/**
 * Replay a run's native frames after a cursor. `cursorSeq` is the last `seq` the
 * client has seen (default -1 → replay from the start, since seq begins at 0);
 * returns frames with seq strictly greater, ordered ascending. Because
 * provider_events is upserted by native id, each `eventId` appears at most once
 * (at its latest revision), so the snapshot is already deduplicated.
 */
export async function getNativeFramesSince(
  runId: string,
  cursorSeq: number,
): Promise<NativeFrame[]> {
  const rows = await db
    .select()
    .from(providerEvents)
    .where(and(eq(providerEvents.runId, runId), gt(providerEvents.seq, cursorSeq)))
    .orderBy(asc(providerEvents.seq));
  return rows.map(rowToNativeFrame);
}
