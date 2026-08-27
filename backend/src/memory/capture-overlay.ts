import { sql } from "drizzle-orm";
import { db } from "../db/client";
import type { MemoryScope } from "../db/schema";
import type { ScopedPool } from "./team-memory";

const MAX_CANDIDATES_PER_ORG = 100;
const MAX_OVERLAY_HITS = 6;
const MAX_OVERLAY_CONTENT = 500;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "do", "does", "for", "i", "in", "is", "it", "me", "my",
  "of", "on", "the", "to", "we", "what", "which", "who", "you", "your",
]);

interface CapturePayloadOverlay {
  identity?: {
    teamId?: unknown;
    agentId?: unknown;
    userId?: unknown;
  };
  prompt?: unknown;
  scope?: unknown;
}

export interface CaptureOverlayHit {
  readonly sourceScope: MemoryScope;
  readonly id: string;
  readonly content: string;
  /** Full normalized prompt, independent of the bounded display content. */
  readonly dedupeKey: string;
}

function terms(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length > 1 && !STOP_WORDS.has(term)) ?? [],
  );
}

function relevant(queryTerms: ReadonlySet<string>, content: string): boolean {
  if (queryTerms.size === 0) return false;
  for (const term of terms(content)) if (queryTerms.has(term)) return true;
  return false;
}

/** Read unconfirmed run captures from Postgres so a newly finalized user fact
 * is recallable before the external memory service indexes it. SQL first limits
 * by tenant + requested scope; payload identity then enforces the exact pool.
 * Only user-authored prompt text is overlaid, avoiding assistant uncertainty or
 * unsupported outcome prose. Delivered/dead rows never enter this view. */
export async function readCaptureOverlay(
  query: string,
  pools: readonly ScopedPool[],
): Promise<CaptureOverlayHit[]> {
  const queryTerms = terms(query);
  if (queryTerms.size === 0 || pools.length === 0) return [];

  const poolByKey = new Map<string, ScopedPool>(
    pools.map((pool) => [
      `${pool.identity.teamId}\0${pool.identity.agentId}\0${pool.identity.userId}`,
      pool,
    ] as const),
  );
  const orgIds = [...new Set(pools.map((pool) => pool.identity.teamId))];
  const hits: CaptureOverlayHit[] = [];
  const seen = new Set<string>();

  for (const orgId of orgIds) {
    const orgPools = pools.filter((pool) => pool.identity.teamId === orgId);
    const includeOrg = orgPools.some((pool) => pool.sourceScope === "org");
    const personalUsers = orgPools
      .filter((pool) => pool.sourceScope === "personal")
      .map((pool) => pool.identity.userId);
    const scopeConditions = [
      ...(includeOrg ? [sql`r.memory_scope = 'org'`] : []),
      ...(personalUsers.length > 0
        ? [sql`(r.memory_scope = 'personal' and r.user_id in (${sql.join(personalUsers.map((id) => sql`${id}`), sql`, `)}))`]
        : []),
    ];
    if (scopeConditions.length === 0) continue;

    let rows: Array<Record<string, unknown>>;
    try {
      rows = (await db.execute(sql`
        select o.id, o.payload
        from memory_outbox o
        join runs r on r.id = o.run_id
        where r.org_id = ${orgId}
          and o.state in ('pending', 'delivering')
          and (${sql.join(scopeConditions, sql` or `)})
        order by o.created_at desc
        limit ${MAX_CANDIDATES_PER_ORG}
      `)) as unknown as Array<Record<string, unknown>>;
    } catch {
      // Recall is best-effort. A local overlay failure must not turn an
      // otherwise usable upstream memory response into a run failure.
      continue;
    }

    for (const row of rows) {
      let payload: CapturePayloadOverlay;
      try {
        payload = JSON.parse(String(row.payload)) as CapturePayloadOverlay;
      } catch {
        continue;
      }
      const identity = payload.identity;
      const key = `${String(identity?.teamId ?? "")}\0${String(identity?.agentId ?? "")}\0${String(identity?.userId ?? "")}`;
      const pool = poolByKey.get(key);
      const content = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
      if (!pool || payload.scope !== pool.sourceScope || !content || !relevant(queryTerms, content)) {
        continue;
      }
      const dedupeKey = content.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      hits.push({
        sourceScope: pool.sourceScope,
        id: String(row.id),
        content: content.slice(0, MAX_OVERLAY_CONTENT),
        dedupeKey,
      });
      if (hits.length === MAX_OVERLAY_HITS) return hits;
    }
  }
  return hits;
}
