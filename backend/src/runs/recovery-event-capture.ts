import { PLATFORM_EVENT_LANES } from "@useagent/agent-harness/canonical";
import type { HarnessInterimEvent } from "../engines/types";
import type { SecretRedactor } from "../secrets/redact";
import type { ReconcileEntry } from "./reconcile-queue";
import { CaptureFenceError, type WriteFence, providerEventExists, recordProviderEvent,
  recordProviderEvents, runSettlementFence, scopedProviderEventId } from "./provider-events";

/** Non-terminal marker showing that a run is being re-probed after restart. */
export const RUN_RECONCILING = "run.reconciling";

/** Payload of the durable "reconciling after restart" marker. `reason` is
 *  "boot-restart" for the initial park frame and "reprobe" for a re-probe
 *  heartbeat; the heartbeat also carries `lastProbeAt` + `eventsRecovered`. */
interface ReconcilingMarkerPayload {
  reason: "boot-restart" | "reprobe";
  sinceMs: number;
  deadlineMs: number;
  lastProbeAt?: number;
  eventsRecovered?: number;
}

function recoveryWriteFence(runId: string, claim?: WriteFence): WriteFence {
  const unsettled = runSettlementFence(runId);
  // Finalization locks run -> claim. Captures use the same order.
  return async (tx) => await unsettled(tx) && (!claim || await claim(tx));
}

/** Upsert the reconciling marker under a stable ID, only while the run and any
 * claim remain active. Best-effort heartbeat; critical recovered text is separate. */
export function recordReconcilingMarker(
  runId: string,
  threadId: string,
  payload: ReconcilingMarkerPayload,
  fence?: WriteFence,
): Promise<void> {
  // A heartbeat from a tick that lost its claim is fenced out like any other write.
  return recordProviderEvent({
    id: `reconciling_${runId}`,
    runId,
    threadId,
    provider: PLATFORM_EVENT_LANES.platform,
    eventType: RUN_RECONCILING,
    payload,
  }, { fence: recoveryWriteFence(runId, fence), required: true }).catch(() => {});
}

/** Append native events a reconciliation surfaced to the canonical run, so SSE
 *  subscribers watch progress and terminal tail activity is durable before seal.
 *  Idempotent: recordProviderEvent upserts on the stable provider event id
 *  (the run-scoped OpenCode part id), the SAME key the live lane uses, so
 *  re-probes and the pre-restart lane never create a duplicate row or collide
 *  with another run. Payloads are redacted like the live lane. Returns the
 *  number durably present after this probe; strict terminal ingestion throws so
 *  the caller retains the run for retry instead of sealing incomplete history. */
export async function ingestReconciliationEvents(
  entry: Pick<ReconcileEntry, "runId" | "threadId">,
  redact: SecretRedactor,
  events: readonly HarnessInterimEvent[],
  strict = false,
  fence?: WriteFence,
): Promise<number> {
  let recovered = 0;
  const captureFence = recoveryWriteFence(entry.runId, fence);
  for (let index = 0; index < events.length; index++) {
    const ev = events[index]!;
    const batch = [ev];
    // The native driver emits an anchor followed by one complete authoritative
    // message revision. Recover its segments atomically, like the live lane.
    if (ev.provider === "t3" && ev.eventType === "t3.message.started") {
      while (index + 1 < events.length) {
        const next = events[index + 1]!;
        if (next.provider !== "t3" || next.eventType !== "t3.message.updated" ||
          next.sessionId !== ev.sessionId || next.messageId !== ev.messageId) break;
        batch.push(next);
        index++;
      }
    }
    try {
      if (batch.some((event) => event.runScopedId && !event.id.startsWith(`pe_${entry.runId}_`))) {
        throw new Error(`Recovered event id does not match run ${entry.runId}`);
      }
      const inputs = batch.map((event) => ({
          id: event.runScopedId ? event.id : scopedProviderEventId(entry.runId, event.id),
          runId: entry.runId,
          threadId: entry.threadId,
          provider: event.provider,
          eventType: event.eventType,
          nativeSessionId: event.sessionId ?? null,
          nativeParentSessionId: event.parentSessionId ?? null,
          nativeMessageId: event.messageId ?? null,
          nativePartId: event.partId ?? null,
          nativeCallId: event.callId ?? null,
          payload: redact.unknown(event.payload),
        }));
      await recordProviderEvents(inputs,
        // A fenced write is required so the fence loss reaches this loop instead of the log.
        { critical: strict, required: true, fence: captureFence },
      );
      for (const input of inputs) {
        if (await providerEventExists(input.id)) recovered++;
        else if (strict) throw new Error(`Recovered event ${input.id} was not durable`);
      }
    } catch (error) {
      if (error instanceof CaptureFenceError) throw new LostClaimError(entry.runId, recovered);
      if (strict) throw error;
      /* a single malformed event must never abort the probe */
    }
  }
  return recovered;
}

/** Thrown when a tick finds, while writing recovered events, that its claim is gone.
 *  Carries how many events of the batch were durable before that, so the count survives. */
export class LostClaimError extends Error {
  constructor(runId: string, readonly recovered = 0) {
    super(`reconcile claim lost for run ${runId}`);
  }
}
