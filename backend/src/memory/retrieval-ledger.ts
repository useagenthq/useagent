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

import { sql } from "drizzle-orm";
import { db } from "../db/client";
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

// ── Read side — "Recently recalled" for the Memory Hub ───────────────────────
// One row per run's recall, org-scoped by a join to `runs`. Surfaces WHAT memory
// each run pulled (query, scope, cited items) with a link back to /session/{runId}.

/** One run's recall, shaped for the Memory Hub "Recently recalled" section. */
export interface RecallLedgerRow {
  readonly runId: string;
  readonly threadId: string;
  readonly memoryScope: MemoryScope;
  readonly query: string;
  readonly itemCount: number;
  readonly items: readonly { readonly content: string; readonly sourceScope: MemoryScope }[];
  readonly latencyMs: number;
  readonly truncated: boolean;
  readonly createdAt: string;
}

const RECALL_ITEM_PREVIEW = 6;

/**
 * List an org's recent recall frames, newest first. Reads the durable
 * `context.retrieved` events off the native lane and org-scopes them via a join
 * to `runs`. The stored payload already excludes credentials; we surface only its
 * query + scope + a capped item preview. Never throws to the caller (SQL only).
 */
export async function listRecallsForOrg(orgId: string, limit = 30): Promise<RecallLedgerRow[]> {
  const rows = (await db.execute(sql`
    select e.run_id, e.thread_id, e.payload, e.created_at
    from provider_events e
    join runs r on r.id = e.run_id
    where e.event_type = ${CONTEXT_RETRIEVED} and r.org_id = ${orgId}
    order by e.created_at desc
    limit ${limit}`)) as unknown as Array<Record<string, unknown>>;
  const out: RecallLedgerRow[] = [];
  for (const r of rows) {
    let payload: RetrievalLedgerPayload | null = null;
    try {
      payload = JSON.parse((r.payload as string) ?? "null") as RetrievalLedgerPayload;
    } catch {
      payload = null;
    }
    if (!payload) continue;
    // Legacy frames (recorded before the scope-aware ledger) carry no
    // memoryScope / per-item sourceScope. Those runs were all org-scoped, so
    // default the absent scope to "org" — honest, matches their real behavior.
    out.push({
      runId: r.run_id as string,
      threadId: r.thread_id as string,
      memoryScope: payload.memoryScope ?? "org",
      query: payload.query,
      itemCount: payload.itemCount,
      items: (payload.items ?? [])
        .slice(0, RECALL_ITEM_PREVIEW)
        .map((i) => ({ content: i.content, sourceScope: i.sourceScope ?? "org" })),
      latencyMs: payload.latencyMs,
      truncated: payload.truncated,
      createdAt: new Date(r.created_at as string).toISOString(),
    });
  }
  return out;
}
