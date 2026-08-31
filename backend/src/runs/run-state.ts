import { and, eq, inArray } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { runs, type RunStatus } from "../db/schema";

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
