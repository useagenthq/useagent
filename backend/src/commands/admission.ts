import { asc, count, eq, inArray, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { commands, runs, type CommandState } from "../db/schema";
import { resolveAdmissionChange } from "./admission-ownership";

const ADMISSION_STATE_ID = "system:run-admission";
const ADMISSION_LOCK_CLASS = 1_397_445_230;
const ADMISSION_LOCK_ID = 1;
const ADMISSION_OPEN = "deployment.admission.open";
const ADMISSION_CLOSED = "deployment.admission.closed";
const ADMISSION_AUDIT = "deployment.admission.audit";
const FORCE_AUDIT = "deployment.drain.forced";

export interface RunAdmissionState {
  readonly open: boolean;
  readonly operationId: string;
  readonly actor: string;
  readonly reason: string;
  readonly changedAt: string;
}

export interface AdmissionChange {
  readonly open: boolean;
  readonly operationId: string;
  readonly actor: string;
  readonly reason: string;
}

export class RunAdmissionClosedError extends Error {
  readonly code = "run_admission_closed";
  readonly state: RunAdmissionState;

  constructor(state: RunAdmissionState) {
    super(`Run admission is closed for ${state.operationId}: ${state.reason}`);
    this.name = "RunAdmissionClosedError";
    this.state = state;
  }
}

export {
  resolveAdmissionChange,
  RunAdmissionOwnershipError,
} from "./admission-ownership";

function parseState(kind: string, payload: string | null): RunAdmissionState {
  let audit: Partial<RunAdmissionState> = {};
  try {
    audit = JSON.parse(payload ?? "{}") as Partial<RunAdmissionState>;
  } catch {
    // A malformed control row must fail closed, with bounded diagnostic data.
  }
  return {
    open: kind === ADMISSION_OPEN,
    operationId: String(audit.operationId ?? "unknown"),
    actor: String(audit.actor ?? "unknown"),
    reason: String(audit.reason ?? "admission state is unavailable"),
    changedAt: String(audit.changedAt ?? "unknown"),
  };
}

async function lockAdmission(exec: Executor, mode: "shared" | "exclusive"): Promise<void> {
  if (mode === "shared") {
    await exec.execute(
      sql`SELECT pg_advisory_xact_lock_shared(${ADMISSION_LOCK_CLASS}, ${ADMISSION_LOCK_ID})`,
    );
    return;
  }
  await exec.execute(
    sql`SELECT pg_advisory_xact_lock(${ADMISSION_LOCK_CLASS}, ${ADMISSION_LOCK_ID})`,
  );
}

async function readState(exec: Executor): Promise<RunAdmissionState> {
  const [row] = await exec
    .select({ kind: commands.kind, payload: commands.payload })
    .from(commands)
    .where(eq(commands.id, ADMISSION_STATE_ID))
    .limit(1);
  // No control row is the backwards-compatible open state. Deploy tooling
  // creates the durable row before draining or mutating a release.
  return row
    ? parseState(row.kind, row.payload)
    : {
        open: true,
        operationId: "bootstrap",
        actor: "system",
        reason: "no deployment boundary is active",
        changedAt: "unknown",
      };
}

async function readUnderSharedLock(exec: Executor): Promise<RunAdmissionState> {
  await lockAdmission(exec, "shared");
  return readState(exec);
}

export async function getRunAdmission(): Promise<RunAdmissionState> {
  return db.transaction(readUnderSharedLock);
}

/** Acquire the shared transaction barrier and reject new acceptance while a
 * deployment owns the durable closed state. Call inside the run insert
 * transaction to make close-vs-accept races deterministic. */
export async function assertRunAdmissionOpen(exec?: Executor): Promise<void> {
  const state = exec
    ? await readUnderSharedLock(exec)
    : await db.transaction(readUnderSharedLock);
  if (!state.open) throw new RunAdmissionClosedError(state);
}

/** Change the singleton admission state and append an immutable audit event in
 * the same exclusive-lock transaction. */
export async function setRunAdmission(change: AdmissionChange): Promise<RunAdmissionState> {
  return db.transaction(async (tx) => {
    await lockAdmission(tx, "exclusive");
    const current = await readState(tx);
    if (resolveAdmissionChange(current, change) === "unchanged") return current;
    const changedAt = new Date().toISOString();
    const state: RunAdmissionState = { ...change, changedAt };
    const payload = JSON.stringify(state);
    const kind = change.open ? ADMISSION_OPEN : ADMISSION_CLOSED;
    await tx
      .insert(commands)
      .values({
        id: ADMISSION_STATE_ID,
        kind,
        payload,
        state: "completed" satisfies CommandState,
        attemptCount: 0,
      })
      .onConflictDoUpdate({
        target: commands.id,
        set: { kind, payload, updatedAt: new Date() },
      });
    await tx.insert(commands).values({
      id: crypto.randomUUID(),
      kind: ADMISSION_AUDIT,
      payload,
      state: "completed" satisfies CommandState,
      attemptCount: 0,
    });
    return state;
  });
}

export async function recordForcedDrain(input: {
  readonly operationId: string;
  readonly actor: string;
  readonly reason: string;
  readonly interruptedRunIds: readonly string[];
}): Promise<void> {
  await db.insert(commands).values({
    id: crypto.randomUUID(),
    kind: FORCE_AUDIT,
    payload: JSON.stringify({ ...input, recordedAt: new Date().toISOString() }),
    state: "completed" satisfies CommandState,
    attemptCount: 0,
  });
}

/**
 * Bounded deployment-only view of work that must settle before restart.
 * Consumed via a dynamic `await import()` in deploy/hetzner/drain-inflight-runs.ts,
 * so a static dead-code sweep cannot see this export - do not remove it.
 */
export async function deploymentInflightSnapshot(
  limit = 25,
): Promise<{ readonly count: number; readonly runIds: readonly string[] }> {
  const active = inArray(runs.status, ["running", "queued"]);
  const [rows, totals] = await Promise.all([
    db
      .select({ id: runs.id })
      .from(runs)
      .where(active)
      .orderBy(asc(runs.createdAt))
      .limit(limit),
    db.select({ total: count() }).from(runs).where(active),
  ]);
  return { count: totals[0]?.total ?? 0, runIds: rows.map((row) => row.id) };
}
