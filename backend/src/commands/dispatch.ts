import { sql } from "drizzle-orm";
import { db } from "../db/client";
import type { EngineId, RunStatus } from "../db/schema";
import { RUN_CANCEL, RUN_CREATE } from "./repo";

// ---------------------------------------------------------------------------
// Durable per-session command lane (north star "Durable Runtime", single-replica
// scope — NO leases/fencing per the gate). Turn ordering lives on the `commands`
// table, not an in-memory promise chain, so a queued reply survives a crash.
//
// Invariants:
//  - At most ONE command per thread is `dispatched` (in flight) at a time.
//  - Within a thread, commands dispatch in creation order.
//  - Across threads, dispatch + execution are fully concurrent.
//
// The claim is a single advisory-locked transaction (compare-and-swap
// queued→dispatched), which — together with the worker's in-memory registry
// guard — makes dispatch idempotent across restarts. This module performs NO
// spawning (that would import the worker and cycle); it returns the run id to
// dispatch and the caller (worker/route/recovery) spawns.
// ---------------------------------------------------------------------------

/** Result of reconciling a command's state against its run's status. */
export type CommandSettle =
  | { readonly status: "completed" } // run reached a terminal state
  | { readonly status: "requeued" } // worker died before the run started
  | { readonly status: "running" } // run still executing (leave dispatched)
  | { readonly status: "none" }; // no command for this run (legacy)

/** A command still in the mailbox (queued or in flight) joined to its run. */
export interface ActiveCommand {
  readonly commandId: string;
  readonly state: "queued" | "dispatched";
  readonly runId: string;
  readonly threadId: string;
  readonly runStatus: RunStatus;
  readonly engine: EngineId;
  readonly engineSessionId: string | null;
  readonly sandboxId: string | null;
  /** A durable user stop committed before the actor/recovery path settled. */
  readonly cancelRequested: boolean;
}

/**
 * Atomically claim a thread's next runnable command. Under a per-thread advisory
 * lock (so concurrent claims for the SAME thread serialize, while different
 * threads stay concurrent): if no command is in flight, transition the OLDEST
 * queued command to `dispatched` and return its run id; otherwise return null.
 * The CAS guarantees a command is dispatched at most once.
 */
export async function claimNextRun(threadId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    // Serialize dispatch decisions for this thread only.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${threadId}))`);

    const inflight = await tx.execute(sql`
      select 1 from commands
      where thread_id = ${threadId} and kind = ${RUN_CREATE} and state = 'dispatched'
      limit 1`);
    if (inflight.length > 0) return null;

    const claimed = await tx.execute(sql`
      update commands
      set state = 'dispatched', attempt_count = attempt_count + 1, updated_at = now()
      where id = (
        select id from commands
        where thread_id = ${threadId} and kind = ${RUN_CREATE} and state = 'queued'
        order by created_at asc, id asc
        limit 1
      )
      returning run_id`);
    const runId = claimed[0]?.run_id;
    return typeof runId === "string" ? runId : null;
  });
}

/**
 * Reconcile a command's state with its run's terminal/queued status. Called when
 * a run settles (mark completed) and on boot for orphaned in-flight commands
 * (complete a terminal run's command, or requeue one whose run never started).
 * Idempotent — the guarded UPDATEs no-op if already in the target state.
 */
export async function settleCommandForRun(runId: string): Promise<CommandSettle> {
  const [row] = await db.execute(sql`
    select r.status as run_status, c.id as cmd_id
    from runs r
    left join commands c on c.run_id = r.id and c.kind = ${RUN_CREATE}
    where r.id = ${runId}
    limit 1`);
  if (!row || !row.cmd_id) return { status: "none" };
  const cmdId = row.cmd_id as string;
  const runStatus = row.run_status as RunStatus;

  if (runStatus === "completed" || runStatus === "failed") {
    await db.execute(sql`
      update commands set state = 'completed', updated_at = now()
      where id = ${cmdId} and state <> 'completed'`);
    return { status: "completed" };
  }
  if (runStatus === "queued") {
    await db.execute(sql`
      update commands set state = 'queued', updated_at = now()
      where id = ${cmdId} and state = 'dispatched'`);
    return { status: "requeued" };
  }
  return { status: "running" };
}

/** Return a claimed (`dispatched`) run.create command to `queued` so the thread
 *  can re-pump it later. Used when the capacity gate DEFERS a run it just claimed
 *  (no capacity yet) — the run never started, so this simply undoes the claim.
 *  Idempotent: no-ops if the command already moved on. */
export async function requeueClaimedCommand(runId: string): Promise<void> {
  await db.execute(sql`
    update commands set state = 'queued', updated_at = now()
    where run_id = ${runId} and kind = ${RUN_CREATE} and state = 'dispatched'`);
}

/** Every command still in the mailbox (queued or dispatched), joined to its run
 *  — the boot reconciler's work list. */
export async function listActiveCommands(): Promise<ActiveCommand[]> {
  const rows = await db.execute(sql`
    select c.id as command_id, c.state, c.run_id, c.thread_id,
           r.status as run_status, r.engine, r.engine_session_id, r.sandbox_id,
           exists (
             select 1 from commands cancel_cmd
             where cancel_cmd.run_id = r.id and cancel_cmd.kind = ${RUN_CANCEL}
           ) as cancel_requested
    from commands c
    join runs r on r.id = c.run_id
    where c.kind = ${RUN_CREATE} and c.state in ('queued', 'dispatched')`);
  return rows.map((r) => ({
    commandId: r.command_id as string,
    state: r.state as "queued" | "dispatched",
    runId: r.run_id as string,
    threadId: r.thread_id as string,
    runStatus: r.run_status as RunStatus,
    engine: r.engine as EngineId,
    engineSessionId: (r.engine_session_id as string | null) ?? null,
    sandboxId: (r.sandbox_id as string | null) ?? null,
    cancelRequested: r.cancel_requested === true,
  }));
}

/**
 * Fail every non-terminal run that has NO active (queued/dispatched) command —
 * legacy runs predating the command lane, or an inconsistent orphan. Runs with a
 * queued command (waiting their turn) are left alone. Returns the count failed.
 */
export async function failCommandlessStaleRuns(summary: string): Promise<number> {
  const res = await db.execute(sql`
    update runs
    set status = 'failed', summary = ${summary}, settled_at = now(), updated_at = now()
    where status in ('queued', 'running')
      and id not in (
        select run_id from commands
        where kind = ${RUN_CREATE} and state in ('queued', 'dispatched') and run_id is not null
      )
    returning id`);
  return res.length;
}
