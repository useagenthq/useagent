// Retrieval ledger (north star "Retrieval Ledger and UX", memory Phase 3a).
//
// Persist WHAT was recalled for each run — scope, query, cited items, latency —
// as a versioned `context.retrieved` frame on the existing native-event lane
// (provider_events + SSE), so it is durable, replayable, and available to a
// future "Context used" surface. No new table: the native lane already gives us
// tenant scope, bounded payloads, dedup-by-id, and a client cursor. Emitting a
// panel/UI is a LATER slice — this only records + streams the event.

import { recordProviderEvent } from "../runs/provider-events";
import type { MemoryIdentity, MemoryRecall } from "./team-memory";

/** The native `eventType` for a retrieval-ledger frame (versioned by the native
 *  lane's NATIVE_SCHEMA_VERSION). */
export const CONTEXT_RETRIEVED = "context.retrieved";

/** The bounded ledger payload: everything the audit trail / "Context used" UX
 *  needs about one run's recall. Bounded by the native capture's payload cap. */
export interface RetrievalLedgerPayload {
  readonly provider: string;
  readonly query: string;
  /** Tenant scope the recall ran under (never the transport credentials).
   *  `userId` is the shared team-memory pool; `actorUserId` is who triggered the
   *  run (provenance) — the two differ once real users run turns. */
  readonly scope: {
    readonly teamId: string;
    readonly userId: string;
    readonly actorUserId: string;
    readonly agentId: string;
    readonly sessionId: string;
  };
  readonly itemCount: number;
  /** The recalled facts + their source citations (assetId/score/provider). */
  readonly items: readonly { readonly content: string; readonly citation: unknown }[];
  readonly renderedChars: number;
  readonly truncated: boolean;
  readonly latencyMs: number;
}

/** Shape the durable ledger payload from a recall (pure — unit-tested). */
export function buildRetrievalPayload(
  identity: MemoryIdentity,
  query: string,
  recall: MemoryRecall,
): RetrievalLedgerPayload {
  return {
    provider: "tencent-memorycore",
    query,
    scope: {
      teamId: identity.teamId,
      userId: identity.userId,
      actorUserId: identity.actorUserId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
    },
    itemCount: recall.items.length,
    items: recall.items.map((item) => ({ content: item.content, citation: item.citation })),
    renderedChars: recall.rendered.length,
    truncated: recall.truncated,
    latencyMs: recall.latencyMs,
  };
}

/**
 * Record a run's recall as a `context.retrieved` native frame (persist + stream).
 * One frame per run (id keyed by runId). No-op when nothing was recalled — a
 * ledger of non-retrievals is noise. Fire-and-forget via recordProviderEvent, so
 * it NEVER fails the run. The caller should `void` this on the hot path.
 */
export async function recordContextRetrieval(
  runId: string,
  threadId: string,
  identity: MemoryIdentity,
  query: string,
  recall: MemoryRecall,
): Promise<void> {
  if (recall.items.length === 0) return;
  await recordProviderEvent({
    id: `ctxret_${runId}`,
    runId,
    threadId,
    // Retrieval happens at run START, before any provider part — seq 0. Rows are
    // deduped by id (unique), so a same-seq provider part is harmless.
    seq: 0,
    provider: "skynet",
    eventType: CONTEXT_RETRIEVED,
    payload: buildRetrievalPayload(identity, query, recall),
  });
}
