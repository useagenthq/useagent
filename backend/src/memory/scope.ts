/**
 * Memory scope policy — maps an authenticated run to the team-memory pool(s) it
 * may read and the single pool it may write, per the memory-scope spec:
 *
 *   team_id      = the authenticated run's orgId
 *   agent_id     = the configured Skynet agent id
 *   org  pool    → user_id = `org:${orgId}`   (every org member shares it)
 *   personal pool → user_id = the run's authenticated userId (private)
 *
 *   - "org" scope     : read org pool only; capture into org pool only.
 *   - "personal" scope: read personal AND org (personal prioritized); capture
 *     into personal ONLY. A personal run with NO authenticated user FAILS CLOSED
 *     — no personal read or write.
 *
 * Identity is ALWAYS resolved from the persisted authenticated run — never from
 * the sandbox, prompt, tool arguments, or a request body. This module is pure
 * policy; the Tencent wire calls live in team-memory.ts.
 */
import { memoryConfig } from "../env";
import { MEMORY_SCOPES, type MemoryScope } from "../db/schema";
import type { MemoryIdentity, ScopedPool } from "./team-memory";

export { MEMORY_SCOPES };
export type { MemoryScope, ScopedPool };

/** Runtime guard for the scope enum — the run-creation boundary rejects anything
 *  else (400) so an invalid scope never reaches a run row. */
export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value);
}

/** The resolved recall/capture plan for one run. `readPools` is priority order
 *  (personal first); an EMPTY `readPools` + null `writePool` is the fail-closed
 *  personal run. Carries the tenant scope the retrieval ledger records. */
export interface ScopedMemoryPlan {
  readonly scope: MemoryScope;
  readonly orgId: string;
  readonly agentId: string;
  readonly sessionId: string;
  /** The authenticated user who triggered the run; null when unauthenticated. */
  readonly actorUserId: string | null;
  /** Pools to search, personal-first. Empty ⇒ fail closed (no read). */
  readonly readPools: readonly ScopedPool[];
  /** The single pool captures go to. Null ⇒ fail closed (no write). */
  readonly writePool: ScopedPool | null;
}

/**
 * Resolve a run's memory plan from its persisted identity + scope. Returns null
 * when memory is disabled (`MEMORY_API_URL` unset) so callers gate cleanly.
 *
 * `run.orgId` is the tenant (Tencent team_id); a legacy/system run with no org
 * falls back to the configured default team so it still resolves a stable pool.
 */
export function resolveScopedMemory(run: {
  orgId: string | null;
  userId: string | null;
  threadId: string;
  id: string;
  memoryScope: MemoryScope;
}): ScopedMemoryPlan | null {
  const cfg = memoryConfig();
  if (!cfg) return null;

  // team_id = the run's org (spec); fall back to the configured default team for
  // a legacy/system run with no org so it still resolves a stable partition.
  const orgId = run.orgId ?? cfg.teamId;
  const base = {
    teamId: orgId,
    agentId: cfg.agentId,
    sessionId: run.threadId,
    runId: run.id,
  } as const;

  const orgPool: ScopedPool = {
    sourceScope: "org",
    identity: {
      ...base,
      userId: `org:${orgId}`,
      // Provenance = the real actor when known, else the shared org partition.
      actorUserId: run.userId ?? `org:${orgId}`,
    },
  };

  const common = {
    orgId,
    agentId: cfg.agentId,
    sessionId: run.threadId,
    actorUserId: run.userId,
  } as const;

  if (run.memoryScope === "org") {
    return { ...common, scope: "org", readPools: [orgPool], writePool: orgPool };
  }

  // personal scope — requires a verified authenticated user, else FAIL CLOSED.
  if (!run.userId) {
    return { ...common, scope: "personal", actorUserId: null, readPools: [], writePool: null };
  }
  const personalPool: ScopedPool = {
    sourceScope: "personal",
    identity: { ...base, userId: run.userId, actorUserId: run.userId },
  };
  return {
    ...common,
    scope: "personal",
    // Personal prioritized; org fills the remaining budget. Capture personal ONLY
    // — personal content must never enter the shared org pool.
    readPools: [personalPool, orgPool],
    writePool: personalPool,
  };
}
