import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { db, type Executor } from "../db/client";

const heldRunLocks = new AsyncLocalStorage<ReadonlySet<string>>();
let sessionLockClient: ReturnType<typeof postgres> | null = null;

function finishedWorkSessionLockClient(): ReturnType<typeof postgres> {
  sessionLockClient ??= postgres(
    process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/useagent",
    { max: 2 },
  );
  return sessionLockClient;
}

export async function lockFinishedWorkRun(runId: string, exec: Executor): Promise<void> {
  await exec.execute(
    sql`select pg_advisory_xact_lock(hashtext('finished-work'), hashtext(${runId}))`,
  );
}

export function withHeldFinishedWorkRunLock<T>(
  runId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const held = new Set(heldRunLocks.getStore() ?? []);
  held.add(runId);
  return heldRunLocks.run(held, operation);
}

export async function withFinishedWorkRunLock<T>(
  runId: string,
  exec: Executor,
  operation: (locked: Executor) => Promise<T>,
): Promise<T> {
  if (heldRunLocks.getStore()?.has(runId)) {
    if (exec === db) return db.transaction(operation);
    return operation(exec);
  }
  if (exec === db) {
    return db.transaction(async (tx) => {
      await lockFinishedWorkRun(runId, tx);
      return operation(tx);
    });
  }
  await lockFinishedWorkRun(runId, exec);
  return operation(exec);
}

/** Hold a run lock, and optionally a source lock, on a small dedicated session
 * pool while the enclosed durable work uses the ordinary database pool. */
export async function withFinishedWorkSessionLocks<T>(
  runId: string,
  sourceKey: string | null,
  operation: () => Promise<T>,
): Promise<T> {
  const sourceLock = sourceKey === null
    ? null
    : `finished-work-source:${runId}:${sourceKey}`;
  let result!: T;
  await finishedWorkSessionLockClient().begin(async (lockTx) => {
    await lockTx`select pg_advisory_xact_lock(hashtext('finished-work'), hashtext(${runId}))`;
    if (sourceLock !== null) {
      await lockTx`select pg_advisory_xact_lock(hashtextextended(${sourceLock}, 0))`;
    }
    result = await withHeldFinishedWorkRunLock(runId, operation);
  });
  return result;
}

export async function resetFinishedWorkSessionLockClientForTest(): Promise<void> {
  const client = sessionLockClient;
  sessionLockClient = null;
  await client?.end({ timeout: 0 });
}

/** Hold finalization behind one run/source serialization boundary while the
 * enclosed durable steps commit in their own transactions. This is intended for
 * workflows that must preserve an open retry checkpoint when a later storage,
 * event, or receipt step fails. */
export async function withFinishedWorkRunSerialization<T>(
  runId: string,
  sourceKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withFinishedWorkSessionLocks(runId, sourceKey, operation);
}
