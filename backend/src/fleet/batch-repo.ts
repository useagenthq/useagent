import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, type Db, type Executor } from "../db/client";
import {
  fleetBatchRuns,
  fleetBatches,
  runAdmissions,
  runs,
  type AdmissionState,
  type QueueReason,
  type RunStatus,
} from "../db/schema";

const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export class FleetBatchIdempotencyConflictError extends Error {
  constructor() {
    super("fleet batch idempotency key was reused for a different request");
    this.name = "FleetBatchIdempotencyConflictError";
  }
}

export interface EnsureFleetBatchInput {
  readonly batchId?: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  /** Run ids in caller-request order. Runs must already exist in the same
   * transaction and belong to `orgId`. */
  readonly runIds: readonly string[];
}

export interface PreflightFleetBatchInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly itemCount: number;
}

export interface FleetBatchRunView {
  readonly ordinal: number;
  readonly runId: string;
  readonly runStatus: RunStatus | "deleted";
  readonly admissionState: AdmissionState | null;
  readonly queueReason: QueueReason | null;
}

export interface FleetBatchView {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly requestFingerprint: string;
  readonly itemCount: number;
  readonly createdAt: Date;
  readonly runs: readonly FleetBatchRunView[];
}

function hashIdempotencyKey(value: string): string {
  if (!value || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error("fleet_batch_idempotency_key_invalid");
  }
  return createHash("sha256").update(value).digest("hex");
}

function requireFingerprint(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error("fleet_batch_request_fingerprint_invalid");
  }
  return normalized;
}

function requireRunIds(runIds: readonly string[]): readonly string[] {
  if (runIds.length < 1 || runIds.length > 20) {
    throw new Error("fleet_batch_item_count_invalid");
  }
  if (new Set(runIds).size !== runIds.length || runIds.some((id) => !id.trim())) {
    throw new Error("fleet_batch_run_ids_invalid");
  }
  return runIds;
}

async function inTransaction<T>(
  exec: Executor,
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  if ("transaction" in exec && typeof exec.transaction === "function") {
    return (exec as Db).transaction((tx) => fn(tx));
  }
  return fn(exec);
}

export async function getFleetBatchForOrg(
  orgId: string,
  batchId: string,
  exec: Executor = db,
): Promise<FleetBatchView | null> {
  const rows = await exec
    .select({
      batch: fleetBatches,
      ordinal: fleetBatchRuns.ordinal,
      runId: fleetBatchRuns.runId,
      runStatus: runs.status,
      admissionState: runAdmissions.state,
      queueReason: runAdmissions.queueReason,
    })
    .from(fleetBatches)
    .innerJoin(
      fleetBatchRuns,
      and(
        eq(fleetBatchRuns.orgId, fleetBatches.orgId),
        eq(fleetBatchRuns.batchId, fleetBatches.id),
      ),
    )
    .leftJoin(runs, eq(runs.id, fleetBatchRuns.runId))
    .leftJoin(runAdmissions, eq(runAdmissions.runId, fleetBatchRuns.runId))
    .where(and(eq(fleetBatches.orgId, orgId), eq(fleetBatches.id, batchId)))
    .orderBy(asc(fleetBatchRuns.ordinal));
  const first = rows[0];
  if (!first) return null;
  return {
    id: first.batch.id,
    orgId: first.batch.orgId,
    actorId: first.batch.actorId,
    requestFingerprint: first.batch.requestFingerprint,
    itemCount: first.batch.itemCount,
    createdAt: first.batch.createdAt,
    runs: rows.map((row) => ({
      ordinal: row.ordinal,
      runId: row.runId,
      runStatus: row.runStatus ?? "deleted",
      admissionState: row.admissionState,
      queueReason: row.queueReason,
    })),
  };
}

async function findFleetBatchByKeyHash(
  orgId: string,
  idempotencyKeyHash: string,
  exec: Executor,
): Promise<FleetBatchView | null> {
  const [batch] = await exec
    .select({ id: fleetBatches.id })
    .from(fleetBatches)
    .where(and(
      eq(fleetBatches.orgId, orgId),
      eq(fleetBatches.idempotencyKeyHash, idempotencyKeyHash),
    ))
    .limit(1);
  return batch ? getFleetBatchForOrg(orgId, batch.id, exec) : null;
}

function assertExactReplay(
  existing: FleetBatchView,
  input: Pick<EnsureFleetBatchInput, "actorId" | "runIds"> & { requestFingerprint: string },
): void {
  if (
    existing.actorId !== input.actorId ||
    existing.requestFingerprint !== input.requestFingerprint ||
    existing.itemCount !== input.runIds.length ||
    existing.runs.length !== input.runIds.length ||
    existing.runs.some((run, ordinal) =>
      run.ordinal !== ordinal || run.runId !== input.runIds[ordinal])
  ) {
    throw new FleetBatchIdempotencyConflictError();
  }
}

function assertReplayRequest(
  existing: FleetBatchView,
  input: Pick<PreflightFleetBatchInput, "actorId" | "itemCount"> & {
    requestFingerprint: string;
  },
): void {
  if (
    existing.actorId !== input.actorId ||
    existing.requestFingerprint !== input.requestFingerprint ||
    existing.itemCount !== input.itemCount
  ) {
    throw new FleetBatchIdempotencyConflictError();
  }
}

/** Resolve an exact retry before the caller allocates or inserts child runs.
 * Callers hold the per-org fleet advisory lock across preflight + acceptance, so
 * concurrent retries cannot race new orphan runs into the transaction. */
export async function preflightFleetBatch(
  input: PreflightFleetBatchInput,
  exec: Executor = db,
): Promise<FleetBatchView | null> {
  if (!Number.isInteger(input.itemCount) || input.itemCount < 1 || input.itemCount > 20) {
    throw new Error("fleet_batch_item_count_invalid");
  }
  const requestFingerprint = requireFingerprint(input.requestFingerprint);
  const existing = await findFleetBatchByKeyHash(
    input.orgId,
    hashIdempotencyKey(input.idempotencyKey),
    exec,
  );
  if (!existing) return null;
  assertReplayRequest(existing, { ...input, requestFingerprint });
  return existing;
}

/**
 * Idempotently insert a product-owned fan-out batch. When passed a caller
 * transaction, the batch participates in the same commit as run acceptance.
 * Standalone calls are wrapped transactionally as a convenience.
 */
export async function ensureFleetBatch(
  input: EnsureFleetBatchInput,
  exec: Executor = db,
): Promise<{ readonly batch: FleetBatchView; readonly created: boolean }> {
  const runIds = requireRunIds(input.runIds);
  const requestFingerprint = requireFingerprint(input.requestFingerprint);
  const idempotencyKeyHash = hashIdempotencyKey(input.idempotencyKey);
  return inTransaction(exec, async (tx) => {
    const [inserted] = await tx
      .insert(fleetBatches)
      .values({
        id: input.batchId,
        orgId: input.orgId,
        actorId: input.actorId,
        idempotencyKeyHash,
        requestFingerprint,
        itemCount: runIds.length,
      })
      .onConflictDoNothing({
        target: [fleetBatches.orgId, fleetBatches.idempotencyKeyHash],
      })
      .returning({ id: fleetBatches.id });

    if (!inserted) {
      const existing = await findFleetBatchByKeyHash(input.orgId, idempotencyKeyHash, tx);
      if (!existing) throw new FleetBatchIdempotencyConflictError();
      assertExactReplay(existing, { ...input, requestFingerprint, runIds });
      return { batch: existing, created: false };
    }

    const ownedRuns = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.orgId, input.orgId), inArray(runs.id, [...runIds])));
    if (ownedRuns.length !== runIds.length) {
      throw new Error("fleet_batch_run_tenant_mismatch");
    }
    await tx.insert(fleetBatchRuns).values(
      runIds.map((runId, ordinal) => ({
        orgId: input.orgId,
        batchId: inserted.id,
        ordinal,
        runId,
      })),
    );
    const batch = await getFleetBatchForOrg(input.orgId, inserted.id, tx);
    if (!batch) throw new Error("fleet_batch_insert_lost");
    return { batch, created: true };
  });
}
