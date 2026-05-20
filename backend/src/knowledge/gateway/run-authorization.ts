import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { runs, type MemoryScope } from "../../db/schema";
import type { ToolTokenClaims } from "./token";

export interface AuthorizedToolRun {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string | null;
  readonly threadId: string;
  readonly memoryScope: MemoryScope;
}

/**
 * A tool capability is usable only while its bound turn is live.
 *
 * "run" scope (legacy default): the exact run it was minted for must be running
 * and still belong to the same tenant, user, and thread - an older turn's token
 * never becomes active again merely because its thread is busy.
 *
 * "thread" scope (perf run-invariant-config slice): the thread must have its
 * SINGLE currently-running turn in the same org - a deliberate, documented
 * relaxation that lets a resident process keep a byte-stable config across warm
 * turns by the SAME user. Outside a live turn the token stays inert; ambiguity
 * (two running rows, an invariant breach) or a different current user fails
 * closed; attribution resolves the active run at call time.
 */
export async function hasMatchingRunningToolRun(claims: ToolTokenClaims): Promise<boolean> {
  return (await resolveAuthorizedToolRun(claims)) !== null;
}

/**
 * Resolve the single live database row authorized by a tool capability.
 *
 * This is the gateway's only current-run lookup. Callers that need persisted
 * run attributes (for example memory scope or event attribution) consume this
 * row instead of independently selecting a newest or fallback run.
 */
export async function resolveAuthorizedToolRun(
  claims: ToolTokenClaims,
): Promise<AuthorizedToolRun | null> {
  const identity = and(
    eq(runs.orgId, claims.orgId),
    eq(runs.threadId, claims.threadId),
    eq(runs.status, "running"),
  );
  const rows = await db
    .select({
      id: runs.id,
      orgId: runs.orgId,
      userId: runs.userId,
      threadId: runs.threadId,
      memoryScope: runs.memoryScope,
    })
    .from(runs)
    .where(claims.scope === "thread" ? identity : and(identity, eq(runs.id, claims.runId)))
    .limit(2);
  const [run] = rows;
  if (rows.length !== 1 || !run) return null;
  if (
    run.orgId !== claims.orgId ||
    run.threadId !== claims.threadId ||
    (run.userId ?? "") !== claims.userId
  ) {
    return null;
  }
  return {
    id: run.id,
    orgId: run.orgId,
    userId: run.userId,
    threadId: run.threadId,
    memoryScope: run.memoryScope,
  };
}

/**
 * Resolve the AUTHORITATIVE identity for this capability, or null (fail closed).
 *
 * For "run" scope the token's own identity stands (it was minted for exactly
 * this run/user). For "thread" scope the run id is resolved at call time, but
 * the signed user id remains an authorization boundary: a different org member
 * must receive a newly configured capability. Identity always comes from the
 * run row, and a mismatch fails closed rather than impersonating either user.
 */
export async function resolveToolRunIdentity(
  claims: ToolTokenClaims,
): Promise<ToolTokenClaims | null> {
  const run = await resolveAuthorizedToolRun(claims);
  if (!run) return null;
  return {
    ...claims,
    orgId: run.orgId,
    userId: run.userId ?? "",
    threadId: run.threadId,
    runId: run.id,
  };
}
