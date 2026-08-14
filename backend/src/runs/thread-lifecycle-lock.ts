import { sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";

/**
 * Serialize lifecycle transitions that can change whether a thread's sandbox is
 * reusable or releasable. The lock is transaction-scoped and tenant-qualified so
 * same thread ids in different orgs cannot block each other.
 */
export async function lockThreadLifecycle(
  exec: Executor,
  orgId: string,
  threadId: string,
): Promise<void> {
  await exec.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`run-thread:${orgId}:${threadId}`}))`,
  );
}

export async function withThreadLifecycleLock<T>(
  orgId: string,
  threadId: string,
  fn: (exec: Executor) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockThreadLifecycle(tx, orgId, threadId);
    return fn(tx);
  });
}
