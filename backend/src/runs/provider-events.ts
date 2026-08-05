import { db } from "../db/client";
import { providerEvents } from "../db/schema";
import { sql } from "drizzle-orm";
import { makeNativeFrame, publishNativeFrame } from "./native-events";

const PAYLOAD_CAP = 32_768; // bounded native payload (chars of JSON)

export type ProviderEventInput = {
  /** Stable id — one row per native part (revisions upsert) or lifecycle key. */
  id: string;
  runId: string;
  threadId: string;
  seq: number;
  provider: string;
  eventType: string;
  nativeSessionId?: string | null;
  nativeParentSessionId?: string | null;
  nativeMessageId?: string | null;
  nativePartId?: string | null;
  nativeCallId?: string | null;
  payload?: unknown;
};

/** Lossless-at-latest-revision capture: idempotent upsert by native identity
 * (the north star's allowed first implementation). MUST never fail a run —
 * callers fire-and-forget; failures are swallowed after a console warning. */
export async function recordProviderEvent(input: ProviderEventInput): Promise<void> {
  try {
    let payload: string | null = null;
    if (input.payload !== undefined) {
      try {
        payload = JSON.stringify(input.payload).slice(0, PAYLOAD_CAP);
      } catch {
        payload = null;
      }
    }
    await db
      .insert(providerEvents)
      .values({
        id: input.id,
        runId: input.runId,
        threadId: input.threadId,
        seq: input.seq,
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
          seq: input.seq,
          eventType: input.eventType,
          payload,
          createdAt: sql`now()`,
        },
        // Revisions can complete out of order (SSE + poller race) — an older
        // revision must never overwrite a newer one (new_prompt.md audit).
        setWhere: sql`${providerEvents.seq} < ${input.seq}`,
      });

    // Live-push the versioned native frame to any SSE subscriber (north star
    // "Canonical Events"). After the persist, so a subscriber never sees a frame
    // that isn't durable. Same bounded payload the replay path reads back.
    publishNativeFrame(
      input.runId,
      makeNativeFrame({
        eventId: input.id,
        seq: input.seq,
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
  } catch (err) {
    console.warn("[provider-events] capture failed:", err instanceof Error ? err.message : err);
  }
}
