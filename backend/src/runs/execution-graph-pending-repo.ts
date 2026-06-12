import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import {
  executionGraphPendingObservations,
  type ExecutionGraphObservationKind,
  type ExecutionGraphPendingObservationRow,
  type ExecutionGraphResolutionReason,
} from "../db/schema";

const STRUCTURE_HASH_VERSION = 1;
export const EXECUTION_GRAPH_RECOVERY_MAX_ATTEMPTS = 12;

function normalizedOptional(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  return normalized || null;
}

function requireSequence(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
  return value;
}

export interface ExecutionGraphObservationStructure {
  readonly kind: ExecutionGraphObservationKind;
  readonly nativeParentSessionId?: string | null;
  readonly nativeChildSessionId?: string | null;
  readonly relevant: boolean;
  readonly executionRequired: boolean;
  readonly controlKind?: string | null;
  readonly providerCallId?: string | null;
  readonly nativeTargetSessionIds?: readonly (string | null)[];
}

export function executionGraphStructureHash(
  input: ExecutionGraphObservationStructure,
): string {
  const canonical = JSON.stringify([
    STRUCTURE_HASH_VERSION,
    input.kind,
    normalizedOptional(input.nativeParentSessionId),
    normalizedOptional(input.nativeChildSessionId),
    input.relevant,
    input.executionRequired,
    normalizedOptional(input.controlKind),
    normalizedOptional(input.providerCallId),
    [...new Set((input.nativeTargetSessionIds ?? []).map(normalizedOptional))]
      .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
  ]);
  return `v${STRUCTURE_HASH_VERSION}:${createHash("sha256").update(canonical).digest("hex")}`;
}

export interface StagePendingObservationInput {
  readonly orgId: string;
  readonly runId: string;
  readonly provider: string;
  readonly providerEventId: string;
  readonly deliverySeq: number;
  readonly structure: ExecutionGraphObservationStructure;
}

export type StagePendingObservationOutcome =
  | "inserted"
  | "updated"
  | "stale"
  | "applied_match"
  | "structural_mismatch";

export async function executionGraphPendingObservationBySource(
  input: Pick<StagePendingObservationInput, "orgId" | "runId" | "provider" | "providerEventId">,
  exec: Executor,
): Promise<ExecutionGraphPendingObservationRow | null> {
  const [row] = await exec
    .select()
    .from(executionGraphPendingObservations)
    .where(and(
      eq(executionGraphPendingObservations.orgId, input.orgId),
      eq(executionGraphPendingObservations.runId, input.runId),
      eq(executionGraphPendingObservations.provider, input.provider),
      eq(executionGraphPendingObservations.providerEventId, input.providerEventId),
    ))
    .limit(1);
  return row ?? null;
}

/** Stage the latest structural classification for one durable provider event.
 * First-deferral order is immutable; database sequence predicates decide which
 * source revision is current. Applied graph identity is never rewritten. */
export async function stageExecutionGraphObservation(
  input: StagePendingObservationInput,
  exec: Executor = db,
): Promise<{ readonly row: ExecutionGraphPendingObservationRow; readonly outcome: StagePendingObservationOutcome }> {
  const deliverySeq = requireSequence(input.deliverySeq, "execution_graph_pending_delivery_seq_invalid");
  const parent = normalizedOptional(input.structure.nativeParentSessionId);
  const child = normalizedOptional(input.structure.nativeChildSessionId);
  const structureHash = executionGraphStructureHash(input.structure);
  const resolvedAt = input.structure.relevant ? null : new Date();
  const resolutionReason = input.structure.relevant ? null : "source_irrelevant" as const;
  const [inserted] = await exec
    .insert(executionGraphPendingObservations)
    .values({
      orgId: input.orgId,
      runId: input.runId,
      provider: input.provider,
      providerEventId: input.providerEventId,
      latestObservationKind: input.structure.kind,
      latestNativeParentSessionId: parent,
      latestNativeChildSessionId: child,
      latestRelevant: input.structure.relevant,
      latestExecutionRequired: input.structure.executionRequired,
      latestStructureHash: structureHash,
      firstDeferredDeliverySeq: deliverySeq,
      latestProviderEventSeq: deliverySeq,
      resolvedAt,
      resolutionReason,
    })
    .onConflictDoNothing({
      target: [
        executionGraphPendingObservations.orgId,
        executionGraphPendingObservations.runId,
        executionGraphPendingObservations.provider,
        executionGraphPendingObservations.providerEventId,
      ],
    })
    .returning();
  if (inserted) return { row: inserted, outcome: "inserted" };

  const current = await executionGraphPendingObservationBySource(input, exec);
  if (!current) throw new Error("execution_graph_pending_upsert_lost");
  if (deliverySeq < current.latestProviderEventSeq) return { row: current, outcome: "stale" };

  if (current.appliedStructureHash) {
    if (current.appliedStructureHash === structureHash) {
      const [advanced] = await exec
        .update(executionGraphPendingObservations)
        .set({ latestProviderEventSeq: deliverySeq })
        .where(and(
          eq(executionGraphPendingObservations.id, current.id),
          sql`${executionGraphPendingObservations.latestProviderEventSeq} <= ${deliverySeq}`,
        ))
        .returning();
      return { row: advanced ?? current, outcome: "applied_match" };
    }
    const now = new Date();
    const [mismatch] = await exec
      .update(executionGraphPendingObservations)
      .set({
        latestObservationKind: input.structure.kind,
        latestNativeParentSessionId: parent,
        latestNativeChildSessionId: child,
        latestRelevant: input.structure.relevant,
        latestExecutionRequired: input.structure.executionRequired,
        latestStructureHash: structureHash,
        latestProviderEventSeq: deliverySeq,
        structuralMismatchAt: now,
        structuralMismatchSourceSeq: deliverySeq,
        structuralMismatchCode: "applied_structure_changed",
      })
      .where(and(
        eq(executionGraphPendingObservations.id, current.id),
        sql`${executionGraphPendingObservations.latestProviderEventSeq} <= ${deliverySeq}`,
      ))
      .returning();
    return { row: mismatch ?? current, outcome: "structural_mismatch" };
  }

  if (deliverySeq === current.latestProviderEventSeq) {
    if (current.latestStructureHash !== structureHash) {
      throw new Error("execution_graph_pending_source_seq_conflict");
    }
    return { row: current, outcome: "updated" };
  }

  const [updated] = await exec
    .update(executionGraphPendingObservations)
    .set({
      latestObservationKind: input.structure.kind,
      latestNativeParentSessionId: parent,
      latestNativeChildSessionId: child,
      latestRelevant: input.structure.relevant,
      latestExecutionRequired: input.structure.executionRequired,
      latestStructureHash: structureHash,
      latestProviderEventSeq: deliverySeq,
      resolvedAt,
      resolutionReason,
      lastAttemptAt: null,
      attemptCount: 0,
      exhaustedAt: null,
      exhaustionCode: null,
    })
    .where(and(
      eq(executionGraphPendingObservations.id, current.id),
      sql`${executionGraphPendingObservations.latestProviderEventSeq} < ${deliverySeq}`,
      isNull(executionGraphPendingObservations.appliedStructureHash),
    ))
    .returning();
  return { row: updated ?? current, outcome: updated ? "updated" : "stale" };
}

export async function markExecutionGraphObservationApplied(
  input: {
    readonly id: string;
    readonly expectedProviderEventSeq: number;
    readonly structure: ExecutionGraphObservationStructure;
    readonly reason: Extract<ExecutionGraphResolutionReason, "applied" | "edge_only">;
  },
  exec: Executor = db,
): Promise<ExecutionGraphPendingObservationRow> {
  const now = new Date();
  const [updated] = await exec
    .update(executionGraphPendingObservations)
    .set({
      appliedStructureHash: executionGraphStructureHash(input.structure),
      resolvedAt: now,
      resolutionReason: input.reason,
      exhaustedAt: null,
      exhaustionCode: null,
    })
    .where(and(
      eq(executionGraphPendingObservations.id, input.id),
      eq(executionGraphPendingObservations.latestProviderEventSeq, requireSequence(
        input.expectedProviderEventSeq,
        "execution_graph_pending_expected_seq_invalid",
      )),
      isNull(executionGraphPendingObservations.appliedStructureHash),
      isNull(executionGraphPendingObservations.structuralMismatchAt),
    ))
    .returning();
  if (updated) return updated;
  const [current] = await exec
    .select()
    .from(executionGraphPendingObservations)
    .where(eq(executionGraphPendingObservations.id, input.id))
    .limit(1);
  if (!current) throw new Error("execution_graph_pending_not_found");
  if (current.appliedStructureHash !== executionGraphStructureHash(input.structure)) {
    throw new Error("execution_graph_pending_apply_conflict");
  }
  return current;
}

export async function recordExecutionGraphRecoveryAttempt(
  id: string,
  exec: Executor = db,
): Promise<void> {
  const now = new Date();
  await exec
    .update(executionGraphPendingObservations)
    .set({
      lastAttemptAt: now,
      attemptCount: sql`${executionGraphPendingObservations.attemptCount} + 1`,
      exhaustedAt: sql`CASE WHEN ${executionGraphPendingObservations.attemptCount} + 1 >= ${EXECUTION_GRAPH_RECOVERY_MAX_ATTEMPTS} THEN now() ELSE ${executionGraphPendingObservations.exhaustedAt} END`,
      exhaustionCode: sql`CASE WHEN ${executionGraphPendingObservations.attemptCount} + 1 >= ${EXECUTION_GRAPH_RECOVERY_MAX_ATTEMPTS} THEN 'attempt_budget_exhausted' ELSE ${executionGraphPendingObservations.exhaustionCode} END`,
    })
    .where(and(
      eq(executionGraphPendingObservations.id, id),
      isNull(executionGraphPendingObservations.resolvedAt),
      sql`${executionGraphPendingObservations.attemptCount} < ${EXECUTION_GRAPH_RECOVERY_MAX_ATTEMPTS}`,
    ));
}

export interface ExecutionGraphRecoveryDiagnostics {
  readonly unresolvedCount: number;
  readonly exhaustedCount: number;
  readonly oldestUnresolvedAt: Date | null;
}

export async function executionGraphRecoveryDiagnostics(
  orgId: string,
  runId: string,
  exec: Executor = db,
): Promise<ExecutionGraphRecoveryDiagnostics> {
  const [row] = await exec
    .select({
      unresolvedCount: sql<number>`count(*)::int`,
      exhaustedCount: sql<number>`count(*) FILTER (WHERE ${executionGraphPendingObservations.exhaustedAt} IS NOT NULL)::int`,
      oldestUnresolvedAt: sql<Date | null>`min(${executionGraphPendingObservations.firstSeenAt})`
        .mapWith(executionGraphPendingObservations.firstSeenAt),
    })
    .from(executionGraphPendingObservations)
    .where(and(
      eq(executionGraphPendingObservations.orgId, orgId),
      eq(executionGraphPendingObservations.runId, runId),
      isNull(executionGraphPendingObservations.resolvedAt),
    ));
  return {
    unresolvedCount: row?.unresolvedCount ?? 0,
    exhaustedCount: row?.exhaustedCount ?? 0,
    oldestUnresolvedAt: row?.oldestUnresolvedAt ?? null,
  };
}

async function unresolvedByNativeKey(
  input: {
    readonly orgId: string;
    readonly runId: string;
    readonly provider: string;
    readonly key: "parent" | "child";
    readonly nativeSessionId: string;
    readonly limit: number;
  },
  exec: Executor,
): Promise<ExecutionGraphPendingObservationRow[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("execution_graph_pending_limit_invalid");
  }
  const column = input.key === "parent"
    ? executionGraphPendingObservations.latestNativeParentSessionId
    : executionGraphPendingObservations.latestNativeChildSessionId;
  return exec
    .select()
    .from(executionGraphPendingObservations)
    .where(and(
      eq(executionGraphPendingObservations.orgId, input.orgId),
      eq(executionGraphPendingObservations.runId, input.runId),
      eq(executionGraphPendingObservations.provider, input.provider),
      eq(column, input.nativeSessionId),
      isNull(executionGraphPendingObservations.resolvedAt),
      isNull(executionGraphPendingObservations.exhaustedAt),
    ))
    .orderBy(
      asc(executionGraphPendingObservations.firstDeferredDeliverySeq),
      asc(executionGraphPendingObservations.id),
    )
    .limit(input.limit);
}

export function unresolvedExecutionGraphObservationsForParent(
  input: Omit<Parameters<typeof unresolvedByNativeKey>[0], "key">,
  exec: Executor = db,
): Promise<ExecutionGraphPendingObservationRow[]> {
  return unresolvedByNativeKey({ ...input, key: "parent" }, exec);
}

export function unresolvedExecutionGraphObservationsForChild(
  input: Omit<Parameters<typeof unresolvedByNativeKey>[0], "key">,
  exec: Executor = db,
): Promise<ExecutionGraphPendingObservationRow[]> {
  return unresolvedByNativeKey({ ...input, key: "child" }, exec);
}

export async function unresolvedExecutionGraphObservationsForRun(
  input: {
    readonly orgId: string;
    readonly runId: string;
    readonly provider: string;
    readonly limit: number;
  },
  exec: Executor = db,
): Promise<ExecutionGraphPendingObservationRow[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("execution_graph_pending_limit_invalid");
  }
  return exec
    .select()
    .from(executionGraphPendingObservations)
    .where(and(
      eq(executionGraphPendingObservations.orgId, input.orgId),
      eq(executionGraphPendingObservations.runId, input.runId),
      eq(executionGraphPendingObservations.provider, input.provider),
      isNull(executionGraphPendingObservations.resolvedAt),
      isNull(executionGraphPendingObservations.exhaustedAt),
    ))
    .orderBy(
      asc(executionGraphPendingObservations.firstDeferredDeliverySeq),
      asc(executionGraphPendingObservations.id),
    )
    .limit(input.limit);
}

export async function executionGraphSealBlockers(
  orgId: string,
  runId: string,
  exec: Executor = db,
): Promise<ExecutionGraphPendingObservationRow[]> {
  const scope = and(
    eq(executionGraphPendingObservations.orgId, orgId),
    eq(executionGraphPendingObservations.runId, runId),
  );
  const [unresolved, mismatch] = await Promise.all([
    exec.select().from(executionGraphPendingObservations)
      .where(and(scope, isNull(executionGraphPendingObservations.resolvedAt)))
      .orderBy(asc(executionGraphPendingObservations.firstDeferredDeliverySeq))
      .limit(1),
    exec.select().from(executionGraphPendingObservations)
      .where(and(scope, isNotNull(executionGraphPendingObservations.structuralMismatchAt)))
      .orderBy(asc(executionGraphPendingObservations.structuralMismatchAt))
      .limit(1),
  ]);
  return [...new Map([...unresolved, ...mismatch].map((row) => [row.id, row])).values()];
}
