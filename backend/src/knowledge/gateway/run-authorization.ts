import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { runs } from "../../db/schema";
import type { ToolTokenClaims } from "./token";

/**
 * A tool capability is usable only while the exact run it was minted for is
 * running and still belongs to the same tenant, user, and thread. Resident
 * processes receive a freshly rewritten token for every warm turn; an older
 * turn's token never becomes active again merely because its thread is busy.
 */
export async function hasMatchingRunningToolRun(claims: ToolTokenClaims): Promise<boolean> {
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
  return Boolean(run && (run.userId ?? "") === claims.userId);
}
