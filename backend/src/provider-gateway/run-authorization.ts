import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { runs, type EngineId } from "../db/schema";

export interface GatewayRun {
  readonly id: string;
  readonly orgId: string | null;
  readonly userId: string | null;
  readonly threadId: string;
  readonly engine: EngineId;
  readonly model: string;
  readonly status: "running";
}

/** Resolve THE currently-running turn of a thread for a thread-scoped capability
 *  (perf run-invariant-config slice). The durable command mailbox guarantees at
 *  most one live run per thread; if that invariant is ever breached (two running
 *  rows) this resolves to NULL - ambiguity fails closed, never picks one. */
export async function findActiveThreadGatewayRun(input: {
  readonly orgId: string;
  readonly threadId: string;
  readonly engine: EngineId;
}): Promise<GatewayRun | null> {
  const rows = await db
    .select({
      id: runs.id,
      orgId: runs.orgId,
      userId: runs.userId,
      threadId: runs.threadId,
      engine: runs.engine,
      model: runs.model,
      status: runs.status,
    })
    .from(runs)
    .where(
      and(
        eq(runs.orgId, input.orgId),
        eq(runs.threadId, input.threadId),
        eq(runs.engine, input.engine),
        eq(runs.status, "running"),
      ),
    )
    .limit(2);
  const [row] = rows;
  if (rows.length !== 1 || !row || row.status !== "running") return null;
  return { ...row, status: "running" };
}

/** Resolve only the exact currently-running turn named by this capability. */
export async function findRunningGatewayRun(input: {
  readonly runId: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly engine: EngineId;
}): Promise<GatewayRun | null> {
  const [row] = await db
    .select({
      id: runs.id,
      orgId: runs.orgId,
      userId: runs.userId,
      threadId: runs.threadId,
      engine: runs.engine,
      model: runs.model,
      status: runs.status,
    })
    .from(runs)
    .where(
      and(
        eq(runs.id, input.runId),
        eq(runs.orgId, input.orgId),
        eq(runs.threadId, input.threadId),
        eq(runs.engine, input.engine),
        eq(runs.status, "running"),
      ),
    )
    .limit(1);
  if (!row || row.status !== "running") return null;
  return { ...row, status: "running" };
}
