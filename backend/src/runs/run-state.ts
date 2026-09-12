import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { runs, type RunStatus } from "../db/schema";
import { MODEL_QUALIFICATION_RUN_ORIGIN } from "./origin";

type RunRecord = typeof runs.$inferSelect;

export async function setRunStatus(id: string, status: RunStatus): Promise<void> {
  await db.update(runs).set({ status, updatedAt: new Date() }).where(eq(runs.id, id));
}

/** Bind a trusted skill revision to the currently running tenant-scoped turn. */
export async function pinSkillToActiveRun(input: {
  runId: string;
  threadId: string;
  orgId: string;
  skillId: string;
  skillVersion: number;
  skillContentHash: string;
}): Promise<boolean> {
  const [row] = await db
    .update(runs)
    .set({
      skillId: input.skillId,
      skillVersion: input.skillVersion,
      skillContentHash: input.skillContentHash,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runs.id, input.runId),
        eq(runs.threadId, input.threadId),
        eq(runs.orgId, input.orgId),
        eq(runs.status, "running"),
      ),
    )
    .returning({ id: runs.id });
  return Boolean(row);
}

/** Customer-facing lookup. Release canaries retain their authenticated direct
 * diagnostics, while autonomous model-qualification runs stay undiscoverable. */
export async function getCustomerRunForOrg(
  orgId: string,
  id: string,
  exec: Executor = db,
): Promise<RunRecord | null> {
  const [row] = await exec
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.id, id),
        eq(runs.orgId, orgId),
        or(isNull(runs.origin), ne(runs.origin, MODEL_QUALIFICATION_RUN_ORIGIN)),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function completeRun(
  id: string,
  status: RunStatus,
  summary: string,
  durationMs: number,
  exec: Executor = db,
): Promise<boolean> {
  // The first finalizer wins; losing races must not enqueue terminal side effects.
  const terminalAt = new Date();
  const [row] = await exec
    .update(runs)
    .set({ status, summary, durationMs, settledAt: terminalAt, updatedAt: terminalAt })
    .where(and(eq(runs.id, id), inArray(runs.status, ["queued", "running"])))
    .returning({ id: runs.id });
  return Boolean(row);
}
