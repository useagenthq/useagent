import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { runs } from "../../db/schema";
import type { ToolTokenClaims } from "./token";

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
  return (await resolveToolRunIdentity(claims)) !== null;
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
  if (claims.scope === "thread") {
    const rows = await db
      .select({ id: runs.id, userId: runs.userId })
      .from(runs)
      .where(
        and(
          eq(runs.orgId, claims.orgId),
          eq(runs.threadId, claims.threadId),
          eq(runs.status, "running"),
        ),
      )
      .limit(2);
    const [run] = rows;
    // Ambiguity (two running rows = invariant breach) fails closed.
    if (rows.length !== 1 || !run) return null;
    const currentUserId = run.userId ?? "";
    if (currentUserId !== claims.userId) return null;
    return { ...claims, runId: run.id, userId: currentUserId };
  }
  const [run] = await db
    .select({ userId: runs.userId })
    .from(runs)
    .where(
      and(
        eq(runs.id, claims.runId),
        eq(runs.orgId, claims.orgId),
        eq(runs.threadId, claims.threadId),
        eq(runs.status, "running"),
      ),
    )
    .limit(1);
  if (!run || (run.userId ?? "") !== claims.userId) return null;
  return claims;
}
