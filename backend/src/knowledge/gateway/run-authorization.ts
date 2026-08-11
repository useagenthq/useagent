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
 * turns. Outside a live turn the token stays inert; ambiguity (two running
 * rows, an invariant breach) fails closed; attribution resolves the active run
 * at call time exactly as before.
 */
export async function hasMatchingRunningToolRun(claims: ToolTokenClaims): Promise<boolean> {
  return (await resolveToolRunIdentity(claims)) !== null;
}

/**
 * Resolve the AUTHORITATIVE identity for this capability, or null (fail closed).
 *
 * For "run" scope the token's own identity stands (it was minted for exactly
 * this run/user). For "thread" scope the token's userId/runId are provenance
 * only - a later turn on the same thread may belong to a DIFFERENT org member,
 * and user-scoped tools (personal memory) MUST act as the CURRENT turn's user,
 * never the minting user. Identity always comes from the run row (D-series
 * rule), so the returned claims carry the resolved run's id and user.
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
    return { ...claims, runId: run.id, userId: run.userId ?? "" };
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
