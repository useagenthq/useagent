// Retrieval ledger (north star "Retrieval Ledger and UX", memory Phase 3a).
//
// Persist WHAT was recalled for each run — scope, query, cited items, latency —
// as a versioned `context.retrieved` frame on the existing native-event lane
// (provider_events + SSE), so it is durable, replayable, and available to a
// future "Context used" surface. No new table: the native lane already gives us
// tenant scope, bounded payloads, dedup-by-id, and a client cursor. Emitting a
// panel/UI is a LATER slice — this only records + streams the event.
//
// Scope-aware: the payload records the run's memoryScope, the per-item
// sourceScope (personal|org), plus orgId + actorUserId, so a future "Context
// used" UI can label each item by pool. No credentials are ever included.

import { recordProviderEvent } from "../runs/provider-events";
import type { ScopedMemoryPlan } from "./scope";
import type { ScopedRecall } from "./team-memory";
import type { MemoryScope } from "../db/schema";

/** The native `eventType` for a retrieval-ledger frame (versioned by the native
 *  lane's NATIVE_SCHEMA_VERSION). */
export const CONTEXT_RETRIEVED = "context.retrieved";

/** The bounded ledger payload: everything the audit trail / "Context used" UX
 *  needs about one run's recall. Bounded by the native capture's payload cap. */
export interface RetrievalLedgerPayload {
  readonly provider: string;
  /** Which context store this recall came from — the discriminator the shared
   *  timeline renders (`context.retrieved(source)`). "memory" here; the knowledge
   *  gateway emits the same event with `source: "knowledge"`. */
  readonly source: "memory";
  readonly query: string;
  /** The pool policy the run ran under. */
  readonly memoryScope: MemoryScope;
  /** Tenant scope the recall ran under (never the transport credentials).
   *  `orgId` is the team; `actorUserId` is who triggered the run (null when
   *  unauthenticated) — kept for provenance, never a memory partition key. */
  readonly scope: {
    readonly orgId: string;
    readonly actorUserId: string | null;
    readonly agentId: string;
    readonly sessionId: string;
  };
  readonly itemCount: number;
  /** The recalled facts, each labeled with the pool it came from + its citation. */
  readonly items: readonly {
    readonly content: string;
    readonly sourceScope: MemoryScope;
    readonly citation: unknown;
  }[];
  readonly renderedChars: number;
  readonly truncated: boolean;
  readonly latencyMs: number;
}

/** Shape the durable ledger payload from a scope plan + its recall (pure). */
export function buildRetrievalPayload(
  plan: ScopedMemoryPlan,
  query: string,
  recall: ScopedRecall,
): RetrievalLedgerPayload {
  return {
    provider: "tencent-memorycore",
    source: "memory",
    query,
    memoryScope: plan.scope,
    scope: {
      orgId: plan.orgId,
      actorUserId: plan.actorUserId,
      agentId: plan.agentId,
      sessionId: plan.sessionId,
    },
    itemCount: recall.items.length,
    items: recall.items.map((item) => ({
      content: item.content,
      sourceScope: item.sourceScope,
      citation: item.citation,
    })),
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
  plan: ScopedMemoryPlan,
  query: string,
  recall: ScopedRecall,
): Promise<void> {
  if (recall.items.length === 0) return;
  // Retrieval happens at run START, before any provider part, so the shared
  // per-run sequencer (provider-events.ts) mints this frame seq 0 and every
  // opencode capture a strictly higher one — no two emitters collide on a seq.
  await recordProviderEvent({
    id: `ctxret_${runId}`,
    runId,
    threadId,
    provider: "skynet",
    eventType: CONTEXT_RETRIEVED,
    payload: buildRetrievalPayload(plan, query, recall),
  });
}
