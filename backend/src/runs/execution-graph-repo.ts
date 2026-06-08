import { and, asc, eq, getTableColumns, gt, or, sql } from "drizzle-orm";
import { db, type Db, type Executor } from "../db/client";
import {
  agentExecutions,
  delegationEdges,
  runs,
  type AgentExecutionRow,
  type DelegationEdgeRow,
  type DelegationKind,
  type ExecutionStatus,
} from "../db/schema";

function requireIdentity(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function optionalIdentity(value: string | null | undefined, code: string): string | null {
  return value == null ? null : requireIdentity(value, code);
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

async function executionBySource(
  orgId: string,
  runId: string,
  sourceKey: string,
  exec: Executor,
): Promise<AgentExecutionRow | null> {
  const [row] = await exec
    .select()
    .from(agentExecutions)
    .where(and(
      eq(agentExecutions.orgId, orgId),
      eq(agentExecutions.runId, runId),
      eq(agentExecutions.sourceKey, sourceKey),
    ))
    .limit(1);
  return row ?? null;
}

export async function executionByNativeSession(
  orgId: string,
  runId: string,
  provider: string,
  nativeSessionId: string,
  exec: Executor = db,
): Promise<AgentExecutionRow | null> {
  const [row] = await exec
    .select()
    .from(agentExecutions)
    .where(and(
      eq(agentExecutions.orgId, orgId),
      eq(agentExecutions.runId, runId),
      eq(agentExecutions.provider, provider),
      eq(agentExecutions.nativeSessionId, nativeSessionId),
    ))
    .limit(1);
  return row ?? null;
}

export async function getExecutionForOrgRun(
  orgId: string,
  runId: string,
  executionId: string,
  exec: Executor = db,
): Promise<AgentExecutionRow | null> {
  const [row] = await exec
    .select()
    .from(agentExecutions)
    .where(and(
      eq(agentExecutions.orgId, orgId),
      eq(agentExecutions.runId, runId),
      eq(agentExecutions.id, executionId),
    ))
    .limit(1);
  return row ?? null;
}

async function requireOwningRun(orgId: string, runId: string, exec: Executor): Promise<void> {
  const [row] = await exec
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
    .limit(1);
  if (!row) throw new Error("execution_owning_run_not_found");
}

function assertExecutionIdentity(
  row: AgentExecutionRow,
  expected: Pick<AgentExecutionRow,
    "mode" | "provider" | "nativeSessionId" | "nativeParentSessionId"
  >,
): void {
  if (
    row.mode !== expected.mode ||
    row.provider !== expected.provider ||
    row.nativeSessionId !== expected.nativeSessionId ||
    row.nativeParentSessionId !== expected.nativeParentSessionId
  ) {
    throw new Error("execution_source_key_identity_conflict");
  }
}

async function insertExecution(
  input: {
    readonly orgId: string;
    readonly runId: string;
    readonly sourceKey: string;
    readonly mode: AgentExecutionRow["mode"];
    readonly provider: string;
    readonly nativeSessionId?: string | null;
    readonly nativeParentSessionId?: string | null;
    readonly status?: ExecutionStatus;
  },
  exec: Executor,
): Promise<AgentExecutionRow> {
  const sourceKey = requireIdentity(input.sourceKey, "execution_source_key_required");
  const provider = requireIdentity(input.provider, "execution_provider_required");
  const identity = {
    mode: input.mode,
    provider,
    nativeSessionId: optionalIdentity(input.nativeSessionId, "execution_native_session_invalid"),
    nativeParentSessionId: optionalIdentity(
      input.nativeParentSessionId,
      "execution_native_parent_session_invalid",
    ),
  } as const;
  await requireOwningRun(input.orgId, input.runId, exec);
  const [inserted] = await exec
    .insert(agentExecutions)
    .values({
      orgId: input.orgId,
      runId: input.runId,
      sourceKey,
      ...identity,
      status: input.status ?? "queued",
    })
    .onConflictDoNothing({
      target: [agentExecutions.orgId, agentExecutions.runId, agentExecutions.sourceKey],
    })
    .returning();
  const row = inserted ?? await executionBySource(input.orgId, input.runId, sourceKey, exec);
  if (!row) throw new Error("execution_insert_lost");
  assertExecutionIdentity(row, identity);
  return row;
}

export interface CreateRootExecutionInput {
  readonly orgId: string;
  readonly runId: string;
  readonly sourceKey: string;
  readonly provider: string;
  readonly nativeSessionId?: string | null;
  readonly status?: ExecutionStatus;
}

/** Idempotently establish the one provider root represented by `sourceKey`. */
export async function createRootExecution(
  input: CreateRootExecutionInput,
  exec: Executor = db,
): Promise<AgentExecutionRow> {
  return insertExecution({
    ...input,
    mode: "root",
    nativeParentSessionId: null,
  }, exec);
}

async function edgeBySource(
  orgId: string,
  runId: string,
  sourceKey: string,
  exec: Executor,
): Promise<DelegationEdgeRow | null> {
  const [row] = await exec
    .select()
    .from(delegationEdges)
    .where(and(
      eq(delegationEdges.orgId, orgId),
      eq(delegationEdges.runId, runId),
      eq(delegationEdges.sourceKey, sourceKey),
    ))
    .limit(1);
  return row ?? null;
}

async function insertEdge(
  input: {
    readonly orgId: string;
    readonly runId: string;
    readonly sourceKey: string;
    readonly parentExecutionId: string;
    readonly childExecutionId?: string | null;
    readonly kind: DelegationKind;
    readonly provider: string;
    readonly providerCallId?: string | null;
    readonly nativeEventId?: string | null;
    readonly nativeTargetSessionId?: string | null;
    readonly observedDeliverySeq: number;
  },
  exec: Executor,
): Promise<{ readonly edge: DelegationEdgeRow; readonly inserted: boolean }> {
  const sourceKey = requireIdentity(input.sourceKey, "delegation_source_key_required");
  if (!Number.isSafeInteger(input.observedDeliverySeq) || input.observedDeliverySeq < 0) {
    throw new Error("delegation_delivery_seq_invalid");
  }
  const identity = {
    parentExecutionId: input.parentExecutionId,
    childExecutionId: input.childExecutionId ?? null,
    kind: input.kind,
    provider: requireIdentity(input.provider, "delegation_provider_required"),
    providerCallId: optionalIdentity(input.providerCallId, "delegation_provider_call_id_invalid"),
    nativeEventId: optionalIdentity(input.nativeEventId, "delegation_native_event_id_invalid"),
    nativeTargetSessionId: optionalIdentity(
      input.nativeTargetSessionId,
      "delegation_native_target_session_invalid",
    ),
    observedDeliverySeq: input.observedDeliverySeq,
  } as const;
  if (identity.providerCallId == null && identity.nativeEventId == null) {
    throw new Error("delegation_provider_identity_required");
  }
  const [inserted] = await exec
    .insert(delegationEdges)
    .values({
      orgId: input.orgId,
      runId: input.runId,
      sourceKey,
      ...identity,
    })
    .onConflictDoNothing({
      target: [delegationEdges.orgId, delegationEdges.runId, delegationEdges.sourceKey],
    })
    .returning();
  let row = inserted ?? await edgeBySource(input.orgId, input.runId, sourceKey, exec);
  if (!row) throw new Error("delegation_edge_insert_lost");
  const immutableKeys = [
    "parentExecutionId",
    "childExecutionId",
    "kind",
    "provider",
    "nativeTargetSessionId",
  ] as const;
  for (const key of immutableKeys) {
    const expected = identity[key];
    if (row[key as keyof DelegationEdgeRow] !== expected) {
      throw new Error("delegation_source_key_identity_conflict");
    }
  }
  if (!inserted && row.observedDeliverySeq < identity.observedDeliverySeq) {
    const [corrected] = await exec
      .update(delegationEdges)
      .set({ observedDeliverySeq: identity.observedDeliverySeq })
      .where(and(
        eq(delegationEdges.orgId, input.orgId),
        eq(delegationEdges.runId, input.runId),
        eq(delegationEdges.id, row.id),
        sql`${delegationEdges.observedDeliverySeq} < ${identity.observedDeliverySeq}`,
      ))
      .returning();
    if (corrected) row = corrected;
  }
  return { edge: row, inserted: inserted != null };
}

export interface RecordNativeChildSpawnInput {
  readonly orgId: string;
  readonly runId: string;
  readonly parentExecutionId: string;
  readonly provider: string;
  readonly childSourceKey: string;
  readonly edgeSourceKey: string;
  readonly nativeSessionId: string;
  readonly nativeParentSessionId?: string | null;
  readonly providerCallId?: string | null;
  readonly nativeEventId?: string | null;
  readonly observedDeliverySeq: number;
}

/** `spawn` is the sole repository operation that mints a child execution. */
export async function recordNativeChildSpawn(
  input: RecordNativeChildSpawnInput,
  exec: Executor = db,
): Promise<{ readonly execution: AgentExecutionRow; readonly edge: DelegationEdgeRow }> {
  return inTransaction(exec, async (tx) => {
    const execution = await insertExecution({
      orgId: input.orgId,
      runId: input.runId,
      sourceKey: input.childSourceKey,
      mode: "native_child",
      provider: input.provider,
      nativeSessionId: requireIdentity(input.nativeSessionId, "native_child_session_required"),
      nativeParentSessionId: input.nativeParentSessionId ?? null,
    }, tx);
    const { edge } = await insertEdge({
      orgId: input.orgId,
      runId: input.runId,
      sourceKey: input.edgeSourceKey,
      parentExecutionId: input.parentExecutionId,
      childExecutionId: execution.id,
      kind: "spawn",
      provider: input.provider,
      providerCallId: input.providerCallId,
      nativeEventId: input.nativeEventId,
      nativeTargetSessionId: execution.nativeSessionId,
      observedDeliverySeq: input.observedDeliverySeq,
    }, tx);
    return { execution, edge };
  });
}

export type ControlDelegationKind = Exclude<DelegationKind, "spawn">;

export interface RecordDelegationControlInput {
  readonly orgId: string;
  readonly runId: string;
  readonly sourceKey: string;
  readonly parentExecutionId: string;
  readonly childExecutionId?: string | null;
  readonly kind: ControlDelegationKind;
  readonly provider: string;
  readonly providerCallId?: string | null;
  readonly nativeEventId?: string | null;
  readonly nativeTargetSessionId?: string | null;
  readonly observedDeliverySeq: number;
}

/** Record parent control flow without ever creating or replacing a child. */
export async function recordDelegationControl(
  input: RecordDelegationControlInput,
  exec: Executor = db,
): Promise<DelegationEdgeRow> {
  if (input.kind === ("spawn" as DelegationKind)) {
    throw new Error("delegation_control_cannot_spawn");
  }
  if (input.kind !== "resume") return (await insertEdge(input, exec)).edge;
  if (!input.childExecutionId) throw new Error("delegation_resume_child_required");
  const childExecutionId = input.childExecutionId;

  return inTransaction(exec, async (tx) => {
    const result = await insertEdge(input, tx);
    if (!result.inserted) return result.edge;
    const [resumed] = await tx
      .update(agentExecutions)
      .set({
        status: "queued",
        attempt: sql`${agentExecutions.attempt} + 1`,
        settledAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentExecutions.orgId, input.orgId),
        eq(agentExecutions.runId, input.runId),
        eq(agentExecutions.id, childExecutionId),
        sql`${agentExecutions.status} IN ('waiting', 'completed', 'failed', 'cancelled')`,
      ))
      .returning({ id: agentExecutions.id });
    if (!resumed) throw new Error("delegation_resume_execution_not_resumable");
    return result.edge;
  });
}

/** Persist a provider observation without applying command-side resume effects. */
export async function recordDelegationObservation(
  input: RecordDelegationControlInput,
  exec: Executor = db,
): Promise<DelegationEdgeRow> {
  if (input.kind === ("spawn" as DelegationKind)) {
    throw new Error("delegation_observation_cannot_spawn");
  }
  return (await insertEdge(input, exec)).edge;
}

export interface AdvanceExecutionLifecycleInput {
  readonly orgId: string;
  readonly runId: string;
  readonly executionId: string;
  readonly status: ExecutionStatus;
  readonly attempt: number;
  readonly eventId: string;
  readonly eventRevision: number;
  readonly deliverySeq: number;
  /** Explicit provider correction authority for a newer terminal verdict. */
  readonly terminalCorrection?: boolean;
  readonly startedAt?: Date | null;
  readonly settledAt?: Date | null;
}

/**
 * Advance lifecycle state only for a strictly newer `(deliverySeq, revision)`
 * watermark. Resume reuses the execution id and may increase `attempt`; stale
 * replay can therefore never roll a resumed child back to an older state.
 */
export async function advanceExecutionLifecycle(
  input: AdvanceExecutionLifecycleInput,
  exec: Executor = db,
): Promise<{ readonly execution: AgentExecutionRow; readonly applied: boolean }> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("execution_attempt_invalid");
  }
  if (!Number.isSafeInteger(input.eventRevision) || input.eventRevision < 0) {
    throw new Error("execution_event_revision_invalid");
  }
  if (!Number.isSafeInteger(input.deliverySeq) || input.deliverySeq < 0) {
    throw new Error("execution_delivery_seq_invalid");
  }
  const timestamps: {
    startedAt?: Date | null;
    settledAt?: Date | null;
  } = {};
  if (input.startedAt !== undefined) timestamps.startedAt = input.startedAt;
  if (input.settledAt !== undefined) timestamps.settledAt = input.settledAt;
  const requestsNonterminal =
    input.status === "queued" || input.status === "running" || input.status === "waiting";
  const transitionAllowed = requestsNonterminal
    ? sql`${agentExecutions.status} NOT IN ('completed', 'failed', 'cancelled')`
    : input.terminalCorrection
      ? eq(agentExecutions.lastEventId, requireIdentity(input.eventId, "execution_event_id_required"))
      : or(
          sql`${agentExecutions.status} NOT IN ('completed', 'failed', 'cancelled')`,
          eq(agentExecutions.status, input.status),
        );
  const [updated] = await exec
    .update(agentExecutions)
    .set({
      status: input.status,
      attempt: input.attempt,
      lastEventId: requireIdentity(input.eventId, "execution_event_id_required"),
      lastEventRevision: input.eventRevision,
      lastDeliverySeq: input.deliverySeq,
      ...timestamps,
      updatedAt: new Date(),
    })
    .where(and(
      eq(agentExecutions.orgId, input.orgId),
      eq(agentExecutions.runId, input.runId),
      eq(agentExecutions.id, input.executionId),
      eq(agentExecutions.attempt, input.attempt),
      transitionAllowed,
      or(
        sql`${agentExecutions.lastDeliverySeq} < ${input.deliverySeq}`,
        and(
          eq(agentExecutions.lastDeliverySeq, input.deliverySeq),
          sql`${agentExecutions.lastEventRevision} < ${input.eventRevision}`,
        ),
      ),
    ))
    .returning();
  if (updated) return { execution: updated, applied: true };

  const [existing] = await exec
    .select()
    .from(agentExecutions)
    .where(and(
      eq(agentExecutions.orgId, input.orgId),
      eq(agentExecutions.runId, input.runId),
      eq(agentExecutions.id, input.executionId),
    ))
    .limit(1);
  if (!existing) throw new Error("execution_not_found");
  return { execution: existing, applied: false };
}

export interface ExecutionGraph {
  readonly version: 1;
  readonly runId: string;
  readonly graphCursor: number;
  readonly executions: AgentExecutionRow[];
  readonly delegationEdges: DelegationEdgeRow[];
}

export interface ExecutionGraphPageCursor {
  readonly graphCursor: number;
  readonly execution: {
    readonly createdAt: string;
    readonly id: string;
  } | null;
  readonly delegationEdge: {
    readonly cursorSeq: number;
  } | null;
}

export interface ExecutionGraphPage extends ExecutionGraph {
  readonly executionHasMore: boolean;
  readonly delegationEdgeHasMore: boolean;
  readonly nextCursor: ExecutionGraphPageCursor;
}

export async function getExecutionGraphPageForRun(
  orgId: string,
  runId: string,
  input: {
    readonly limit: number;
    readonly cursor: ExecutionGraphPageCursor;
  },
  exec: Executor = db,
): Promise<ExecutionGraphPage | null> {
  const [owningRun] = await exec
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
    .limit(1);
  if (!owningRun) return null;

  const executionCursor = input.cursor.execution;
  const edgeCursor = input.cursor.delegationEdge;
  const executionPage = exec
    .select({
      ...getTableColumns(agentExecutions),
      cursorCreatedAt: sql<string>`${agentExecutions.createdAt}::text`,
    })
    .from(agentExecutions)
    .where(and(
      eq(agentExecutions.orgId, orgId),
      eq(agentExecutions.runId, runId),
      executionCursor
        ? or(
            sql`${agentExecutions.createdAt} > ${executionCursor.createdAt}::timestamptz`,
            and(
              sql`${agentExecutions.createdAt} = ${executionCursor.createdAt}::timestamptz`,
              gt(agentExecutions.id, executionCursor.id),
            ),
          )
        : undefined,
    ))
    .orderBy(asc(agentExecutions.createdAt), asc(agentExecutions.id))
    .limit(input.limit + 1);
  const edgePage = exec
    .select()
    .from(delegationEdges)
    .where(and(
      eq(delegationEdges.orgId, orgId),
      eq(delegationEdges.runId, runId),
      edgeCursor
        ? gt(delegationEdges.cursorSeq, edgeCursor.cursorSeq)
        : undefined,
    ))
    .orderBy(asc(delegationEdges.cursorSeq))
    .limit(input.limit + 1);

  const [executionRows, edgeRows] = await Promise.all([executionPage, edgePage]);
  const executions = executionRows.slice(0, input.limit);
  const delegationEdgesPage = edgeRows.slice(0, input.limit);
  const lastExecution = executions.at(-1);
  const lastEdge = delegationEdgesPage.at(-1);
  const graphCursor = Math.max(
    input.cursor.graphCursor,
    ...executions.map((execution) => execution.lastDeliverySeq),
    ...delegationEdgesPage.map((edge) => edge.observedDeliverySeq),
  );

  return {
    version: 1,
    runId,
    graphCursor,
    executions,
    delegationEdges: delegationEdgesPage,
    executionHasMore: executionRows.length > input.limit,
    delegationEdgeHasMore: edgeRows.length > input.limit,
    nextCursor: {
      graphCursor,
      execution: lastExecution
        ? { createdAt: lastExecution.cursorCreatedAt, id: lastExecution.id }
        : executionCursor,
      delegationEdge: lastEdge
        ? { cursorSeq: lastEdge.cursorSeq }
        : edgeCursor,
    },
  };
}

export async function getExecutionGraphForRun(
  orgId: string,
  runId: string,
  exec: Executor = db,
): Promise<ExecutionGraph | null> {
  const [owningRun] = await exec
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
    .limit(1);
  if (!owningRun) return null;

  const [executions, edges] = await Promise.all([
    exec.select().from(agentExecutions).where(and(
      eq(agentExecutions.orgId, orgId),
      eq(agentExecutions.runId, runId),
    )).orderBy(asc(agentExecutions.createdAt), asc(agentExecutions.id)),
    exec.select().from(delegationEdges).where(and(
      eq(delegationEdges.orgId, orgId),
      eq(delegationEdges.runId, runId),
    )).orderBy(asc(delegationEdges.observedDeliverySeq), asc(delegationEdges.id)),
  ]);
  return {
    version: 1,
    runId,
    graphCursor: Math.max(
      0,
      ...executions.map((execution) => execution.lastDeliverySeq),
      ...edges.map((edge) => edge.observedDeliverySeq),
    ),
    executions,
    delegationEdges: edges,
  };
}
