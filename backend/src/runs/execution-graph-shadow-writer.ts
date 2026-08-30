import { and, asc, eq, gt, or } from "drizzle-orm";
import { db, type Db, type Executor } from "../db/client";
import {
  agentExecutions,
  providerEvents,
  runs,
  type AgentExecutionRow,
  type ExecutionGraphPendingObservationRow,
  type ExecutionStatus,
} from "../db/schema";
import { errorMessage } from "../util/error-message";
import type { ProviderEventInput } from "./provider-events";
import {
  advanceExecutionLifecycle,
  createRootExecution,
  executionByNativeSession,
  recordDelegationObservation,
  recordNativeChildSpawn,
  type ControlDelegationKind,
} from "./execution-graph-repo";
import {
  executionGraphPendingObservationBySource,
  executionGraphSealBlockers,
  markExecutionGraphObservationApplied,
  recordExecutionGraphRecoveryAttempt,
  stageExecutionGraphObservation,
  unresolvedExecutionGraphObservationsForChild,
  unresolvedExecutionGraphObservationsForParent,
  unresolvedExecutionGraphObservationsForRun,
  type ExecutionGraphObservationStructure,
} from "./execution-graph-pending-repo";

const SUPPORTED_PROVIDERS = new Set(["opencode", "pi", "t3"]);
const CONTROL_KINDS = new Set<ControlDelegationKind>([
  "wait",
  "send",
  "resume",
  "close",
  "gather",
]);
const LOG_VALUE_CAP = 160;
const RECOVERY_WORK_LIMIT = 100;

type RecordValue = Record<string, unknown>;

async function inTransaction<T>(
  exec: Executor,
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  if ("transaction" in exec && typeof exec.transaction === "function") {
    return (exec as Db).transaction((tx) => fn(tx));
  }
  return fn(exec);
}

function recordValue(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function stringArray(...values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) =>
    Array.isArray(value)
      ? value.flatMap((item) => stringValue(item) ?? [])
      : stringValue(value) ?? []
  ))];
}

function activityPayload(input: ProviderEventInput): {
  readonly activity: RecordValue | null;
  readonly payload: RecordValue | null;
} {
  const activity = recordValue(input.payload);
  return {
    activity,
    payload: input.provider === "pi" ? activity : recordValue(activity?.payload),
  };
}

async function owningOrgId(runId: string, exec: Executor): Promise<string | null> {
  const [row] = await exec
    .select({ orgId: runs.orgId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return stringValue(row?.orgId);
}

async function parentExecution(
  orgId: string,
  input: ProviderEventInput,
  nativeParentSessionId: string,
  exec: Executor,
): Promise<AgentExecutionRow | null> {
  const exact = await executionByNativeSession(
    orgId,
    input.runId,
    input.provider,
    nativeParentSessionId,
    exec,
  );
  if (exact || input.provider !== "t3") return exact;
  const { payload } = activityPayload(input);
  const agentPath = stringValue(payload?.agentPath);
  if (!agentPath || !/^\/root\/[^/]+$/u.test(agentPath)) return null;
  // The product session starts before the embedded provider publishes its real
  // parent thread id, so the root is initially keyed by the product alias.
  // Trusted top-level child notifications carry the real provider parent id;
  // only an explicit top-level /root/<agent> path may bind that alias. Nested
  // children never fall back to root when their real parent has not arrived.
  const [root] = await exec
    .select()
    .from(agentExecutions)
    .where(and(
      eq(agentExecutions.orgId, orgId),
      eq(agentExecutions.runId, input.runId),
      eq(agentExecutions.provider, input.provider),
      eq(agentExecutions.mode, "root"),
    ))
    .limit(1);
  return root ?? null;
}

function taskReceiptSessionId(detail: unknown): string | null {
  const text = stringValue(detail);
  if (!text) return null;
  const match = /<task\s+id="([A-Za-z0-9._:-]{1,256})"(?:\s|>)/u.exec(text);
  return match?.[1] ?? null;
}

function lifecycleStatus(input: ProviderEventInput): ExecutionStatus | null {
  const { activity, payload } = activityPayload(input);
  const raw = stringValue(
    payload?.status,
    recordValue(input.payload)?.status,
    recordValue(recordValue(input.payload)?.state)?.status,
  )?.toLowerCase();
  if (
    input.eventType.endsWith(".error") ||
    input.eventType.endsWith(".failed") ||
    activity?.tone === "error" ||
    raw === "error" ||
    raw === "failed"
  ) return "failed";
  if (input.eventType.endsWith(".completed") || raw === "completed" || raw === "ok") {
    return "completed";
  }
  if (raw === "cancelled" || raw === "canceled" || raw === "closed") return "cancelled";
  if (raw === "waiting" || raw === "idle") return "waiting";
  if (
    input.eventType.endsWith(".started") ||
    input.eventType === "part.subtask" ||
    raw === "running" ||
    raw === "inprogress" ||
    raw === "started"
  ) return "running";
  return null;
}

function explicitSpawnIdentity(input: ProviderEventInput): {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly providerCallId: string | null;
} | null {
  const { payload } = activityPayload(input);

  if (
    input.provider === "opencode" &&
    (input.eventType === "session.created" || input.eventType === "session.updated")
  ) {
    const childSessionId = stringValue(input.nativeSessionId);
    const parentSessionId = stringValue(input.nativeParentSessionId);
    return childSessionId && parentSessionId
      ? { childSessionId, parentSessionId, providerCallId: stringValue(input.nativeCallId) }
      : null;
  }

  if (
    input.provider === "pi" &&
    input.eventType === "part.subtask" &&
    stringValue(payload?.childEventKind) === "child.started"
  ) {
    const childSessionId = stringValue(payload?.childSessionId);
    const parentSessionId = stringValue(input.nativeParentSessionId, input.nativeSessionId);
    return childSessionId && parentSessionId
      ? { childSessionId, parentSessionId, providerCallId: stringValue(input.nativeCallId) }
      : null;
  }

  if (input.provider === "t3" && input.eventType === "t3.activity.task.started") {
    const childSessionId = stringValue(input.nativeSessionId, payload?.taskId);
    const parentSessionId = stringValue(input.nativeParentSessionId, payload?.parentAgentId);
    return childSessionId && parentSessionId
      ? {
          childSessionId,
          parentSessionId,
          providerCallId: stringValue(payload?.toolUseId, input.nativeCallId),
        }
      : null;
  }

  if (
    input.provider === "t3" &&
    payload?.itemType === "collab_agent_tool_call" &&
    (payload?.delegationKind === "spawn" ||
      (!stringValue(payload?.delegationKind) &&
        input.eventType.endsWith(".completed") &&
        taskReceiptSessionId(payload?.detail))) &&
    (input.eventType.endsWith(".started") ||
      input.eventType.endsWith(".completed") ||
      activityPayload(input).activity?.kind === "tool.started" ||
      activityPayload(input).activity?.kind === "tool.completed")
  ) {
    const childSessionId = stringValue(
      payload.childSessionId,
      payload.taskId,
      taskReceiptSessionId(payload.detail),
    );
    const parentSessionId = stringValue(input.nativeSessionId);
    return childSessionId && parentSessionId
      ? {
          childSessionId,
          parentSessionId,
          providerCallId: stringValue(payload.toolUseId, payload.toolCallId, input.nativeCallId),
        }
      : null;
  }

  return null;
}

function explicitControl(input: ProviderEventInput): {
  readonly kind: ControlDelegationKind;
  readonly parentSessionId: string;
  readonly providerCallId: string | null;
  readonly targetSessionIds: readonly (string | null)[];
} | null {
  if (input.provider !== "t3") return null;
  const { activity, payload } = activityPayload(input);
  const terminal =
    input.eventType.endsWith(".completed") ||
    input.eventType.endsWith(".error") ||
    input.eventType.endsWith(".failed") ||
    input.eventType.endsWith(".denied") ||
    activity?.kind === "tool.completed" ||
    activity?.kind === "tool.error" ||
    activity?.kind === "tool.failed" ||
    activity?.kind === "tool.denied";
  if (!terminal) return null;
  const kind = stringValue(payload?.delegationKind);
  const parentSessionId = stringValue(input.nativeSessionId);
  if (!parentSessionId || !kind || !CONTROL_KINDS.has(kind as ControlDelegationKind)) return null;
  const data = recordValue(payload?.data);
  const item = recordValue(data?.item);
  const targetSessionIds = stringArray(
    payload?.childSessionId,
    payload?.taskId,
    payload?.receiverThreadIds,
    data?.receiverThreadIds,
    item?.receiverThreadIds,
  );
  return {
    kind: kind as ControlDelegationKind,
    parentSessionId,
    providerCallId: stringValue(payload?.toolUseId, payload?.toolCallId, input.nativeCallId),
    targetSessionIds: targetSessionIds.length > 0 ? targetSessionIds : [null],
  };
}

type GraphObservation =
  | { readonly kind: "root" }
  | { readonly kind: "spawn"; readonly spawn: NonNullable<ReturnType<typeof explicitSpawnIdentity>> }
  | { readonly kind: "control"; readonly control: NonNullable<ReturnType<typeof explicitControl>> }
  | { readonly kind: "lifecycle" };

function lifecycleNativeSessionId(input: ProviderEventInput): string | null {
  const { payload } = activityPayload(input);
  return input.provider === "pi"
    ? stringValue(payload?.childSessionId)
    : stringValue(input.nativeSessionId);
}

function observationStructure(
  input: ProviderEventInput,
  observation: Exclude<GraphObservation, { readonly kind: "root" }>,
): ExecutionGraphObservationStructure {
  if (observation.kind === "spawn") {
    return {
      kind: "spawn",
      nativeParentSessionId: observation.spawn.parentSessionId,
      nativeChildSessionId: observation.spawn.childSessionId,
      relevant: true,
      executionRequired: true,
    };
  }
  if (observation.kind === "control") {
    return {
      kind: "control",
      nativeParentSessionId: observation.control.parentSessionId,
      nativeChildSessionId: null,
      relevant: true,
      // Provider-observed controls remain edge-only. A future product-owned
      // resume toward an outliving handle is a separate admitted command lane.
      executionRequired: false,
      controlKind: observation.control.kind,
      providerCallId: observation.control.providerCallId,
      nativeTargetSessionIds: observation.control.targetSessionIds,
    };
  }
  return {
    kind: "lifecycle",
    nativeParentSessionId: stringValue(input.nativeParentSessionId, input.nativeSessionId),
    nativeChildSessionId: lifecycleNativeSessionId(input),
    relevant: true,
    executionRequired: true,
  };
}

function graphObservation(input: ProviderEventInput): GraphObservation | null {
  if (!SUPPORTED_PROVIDERS.has(input.provider)) return null;
  if (input.eventType === "session.started" && stringValue(input.nativeSessionId)) {
    return { kind: "root" };
  }
  const spawn = explicitSpawnIdentity(input);
  if (spawn) return { kind: "spawn", spawn };
  const control = explicitControl(input);
  if (control) return { kind: "control", control };
  if (input.provider === "pi" && input.eventType.startsWith("part.subtask")) {
    const { payload } = activityPayload(input);
    return stringValue(payload?.childSessionId) && lifecycleStatus(input)
      ? { kind: "lifecycle" }
      : null;
  }
  if (input.provider !== "t3" || !input.eventType.startsWith("t3.activity.task.")) {
    return null;
  }
  const { payload } = activityPayload(input);
  return payload?.agentKind === "agent" &&
    stringValue(input.nativeSessionId) &&
    stringValue(input.nativeParentSessionId) &&
    lifecycleStatus(input)
    ? { kind: "lifecycle" }
    : null;
}

export function executionGraphObservationKind(input: ProviderEventInput): GraphObservation["kind"] | null {
  return graphObservation(input)?.kind ?? null;
}

async function advanceChild(
  orgId: string,
  input: ProviderEventInput,
  deliverySeq: number,
  exec: Executor,
  outOfOrderTerminalRecovery = false,
): Promise<boolean> {
  const nativeSessionId = lifecycleNativeSessionId(input);
  const status = lifecycleStatus(input);
  if (!nativeSessionId || !status) return false;
  const execution = await executionByNativeSession(
    orgId,
    input.runId,
    input.provider,
    nativeSessionId,
    exec,
  );
  if (!execution || execution.mode !== "native_child") return false;
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  await advanceExecutionLifecycle({
    orgId,
    runId: input.runId,
    executionId: execution.id,
    status,
    attempt: execution.attempt,
    eventId: input.id,
    eventRevision: 1,
    deliverySeq,
    terminalCorrection: terminal && execution.lastEventId === input.id,
    outOfOrderTerminalRecovery: terminal && outOfOrderTerminalRecovery,
    ...(status === "running" && execution.startedAt == null ? { startedAt: new Date() } : {}),
    ...(terminal ? { settledAt: new Date() } : {}),
  }, exec);
  return true;
}

interface ApplyObservationResult {
  readonly applied: boolean;
  readonly resolutionReason?: "applied" | "edge_only";
  readonly wakeParentSessionIds: readonly string[];
  readonly wakeChildSessionIds: readonly string[];
}

async function applyObservation(
  orgId: string,
  input: ProviderEventInput,
  deliverySeq: number,
  observation: Exclude<GraphObservation, { readonly kind: "root" }>,
  exec: Executor,
  recovering = false,
): Promise<ApplyObservationResult> {
  if (observation.kind === "spawn") {
    const { spawn } = observation;
    const parent = await parentExecution(orgId, input, spawn.parentSessionId, exec);
    if (!parent) return { applied: false, wakeParentSessionIds: [], wakeChildSessionIds: [] };
    const spawned = await recordNativeChildSpawn({
      orgId,
      runId: input.runId,
      parentExecutionId: parent.id,
      provider: input.provider,
      childSourceKey: `child:${input.provider}:${spawn.childSessionId}`,
      edgeSourceKey: `edge:${input.provider}:spawn:${spawn.childSessionId}`,
      nativeSessionId: spawn.childSessionId,
      nativeParentSessionId: spawn.parentSessionId,
      providerCallId: spawn.providerCallId,
      nativeEventId: input.id,
      observedDeliverySeq: deliverySeq,
    }, exec);
    const observedStatus = lifecycleStatus(input);
    const status = observedStatus === "completed" || observedStatus === "failed" ||
        observedStatus === "cancelled"
      ? observedStatus
      : "running";
    await advanceExecutionLifecycle({
      orgId,
      runId: input.runId,
      executionId: spawned.execution.id,
      status,
      attempt: spawned.execution.attempt,
      eventId: input.id,
      eventRevision: 1,
      deliverySeq,
      ...(spawned.execution.startedAt == null ? { startedAt: new Date() } : {}),
      ...(status === "completed" || status === "failed" || status === "cancelled"
        ? { settledAt: new Date() }
        : {}),
    }, exec);
    return {
      applied: true,
      resolutionReason: "applied",
      wakeParentSessionIds: [spawn.childSessionId],
      wakeChildSessionIds: [spawn.childSessionId],
    };
  }

  if (observation.kind === "control") {
    const { control } = observation;
    const parent = await parentExecution(orgId, input, control.parentSessionId, exec);
    if (!parent) return { applied: false, wakeParentSessionIds: [], wakeChildSessionIds: [] };
    for (const targetSessionId of control.targetSessionIds) {
      const child = targetSessionId
        ? await executionByNativeSession(orgId, input.runId, input.provider, targetSessionId, exec)
        : null;
      await recordDelegationObservation({
        orgId,
        runId: input.runId,
        sourceKey: `edge:${input.provider}:${control.kind}:${control.providerCallId ?? input.id}:${targetSessionId ?? "none"}`,
        parentExecutionId: parent.id,
        childExecutionId: child?.id ?? null,
        kind: control.kind,
        provider: input.provider,
        providerCallId: control.providerCallId,
        nativeEventId: input.id,
        nativeTargetSessionId: targetSessionId,
        observedDeliverySeq: deliverySeq,
      }, exec);
    }
    return {
      applied: true,
      resolutionReason: "edge_only",
      wakeParentSessionIds: [],
      wakeChildSessionIds: [],
    };
  }

  return {
    applied: await advanceChild(orgId, input, deliverySeq, exec, recovering),
    resolutionReason: "applied",
    wakeParentSessionIds: [],
    wakeChildSessionIds: [],
  };
}

async function providerInputForPending(
  row: Pick<ExecutionGraphPendingObservationRow, "runId" | "provider" | "providerEventId">,
  exec: Executor,
): Promise<{ readonly input: ProviderEventInput; readonly seq: number } | null> {
  const [event] = await exec
    .select()
    .from(providerEvents)
    .where(and(
      eq(providerEvents.runId, row.runId),
      eq(providerEvents.provider, row.provider),
      eq(providerEvents.id, row.providerEventId),
    ))
    .limit(1);
  if (!event) return null;
  return providerInputFromRow(event);
}

function providerInputFromRow(
  event: typeof providerEvents.$inferSelect,
): { readonly input: ProviderEventInput; readonly seq: number } {
  let payload: unknown;
  if (event.payload != null) {
    try {
      payload = JSON.parse(event.payload);
    } catch {
      payload = undefined;
    }
  }
  return {
    seq: event.seq,
    input: {
      id: event.id,
      runId: event.runId,
      threadId: event.threadId,
      provider: event.provider,
      eventType: event.eventType,
      nativeSessionId: event.nativeSessionId,
      nativeParentSessionId: event.nativeParentSessionId,
      nativeMessageId: event.nativeMessageId,
      nativePartId: event.nativePartId,
      nativeCallId: event.nativeCallId,
      payload,
    },
  };
}

async function recoverPendingObservations(
  input: {
    readonly orgId: string;
    readonly runId: string;
    readonly provider: string;
    readonly seedParentSessionIds?: readonly string[];
    readonly seedChildSessionIds?: readonly string[];
    readonly includeRunScan?: boolean;
  },
  exec: Executor,
): Promise<void> {
  const queue = new Map<string, Awaited<ReturnType<typeof unresolvedExecutionGraphObservationsForRun>>[number]>();
  const add = (rows: Awaited<ReturnType<typeof unresolvedExecutionGraphObservationsForRun>>) => {
    for (const row of rows) queue.set(row.id, row);
  };
  if (input.includeRunScan) {
    add(await unresolvedExecutionGraphObservationsForRun({ ...input, limit: RECOVERY_WORK_LIMIT }, exec));
  }
  for (const nativeSessionId of input.seedParentSessionIds ?? []) {
    add(await unresolvedExecutionGraphObservationsForParent({
      ...input,
      nativeSessionId,
      limit: RECOVERY_WORK_LIMIT,
    }, exec));
  }
  for (const nativeSessionId of input.seedChildSessionIds ?? []) {
    add(await unresolvedExecutionGraphObservationsForChild({
      ...input,
      nativeSessionId,
      limit: RECOVERY_WORK_LIMIT,
    }, exec));
  }

  const attempts = new Map<string, number>();
  let processed = 0;
  while (queue.size > 0 && processed < RECOVERY_WORK_LIMIT) {
    const next = [...queue.entries()].sort((a, b) =>
      a[1].firstDeferredDeliverySeq - b[1].firstDeferredDeliverySeq || a[0].localeCompare(b[0])
    )[0];
    if (!next) break;
    const [id, pointer] = next;
    queue.delete(id);
    const priorAttempts = attempts.get(id) ?? 0;
    if (priorAttempts >= 3) continue;
    attempts.set(id, priorAttempts + 1);
    processed += 1;
    await recordExecutionGraphRecoveryAttempt(id, exec);
    const source = await providerInputForPending(pointer, exec);
    if (!source) continue;
    const observation = graphObservation(source.input);
    if (!observation || observation.kind === "root") continue;
    const structure = observationStructure(source.input, observation);
    const staged = await stageExecutionGraphObservation({
      orgId: input.orgId,
      runId: input.runId,
      provider: input.provider,
      providerEventId: source.input.id,
      deliverySeq: source.seq,
      structure,
    }, exec);
    if (staged.outcome === "stale" || staged.outcome === "structural_mismatch") continue;
    const applied = await applyObservation(input.orgId, source.input, source.seq, observation, exec, true);
    if (!applied.applied || !applied.resolutionReason) continue;
    await markExecutionGraphObservationApplied({
      id: staged.row.id,
      expectedProviderEventSeq: source.seq,
      structure,
      reason: applied.resolutionReason,
    }, exec);
    for (const nativeSessionId of applied.wakeParentSessionIds) {
      add(await unresolvedExecutionGraphObservationsForParent({
        ...input,
        nativeSessionId,
        limit: RECOVERY_WORK_LIMIT,
      }, exec));
    }
    for (const nativeSessionId of applied.wakeChildSessionIds) {
      add(await unresolvedExecutionGraphObservationsForChild({
        ...input,
        nativeSessionId,
        limit: RECOVERY_WORK_LIMIT,
      }, exec));
    }
  }
}

async function writeExecutionGraph(
  input: ProviderEventInput,
  deliverySeq: number,
  exec: Executor,
): Promise<void> {
  const observation = graphObservation(input);
  if (!observation) return;
  const orgId = await owningOrgId(input.runId, exec);
  if (!orgId) return;

  if (observation.kind === "root") {
    const nativeSessionId = stringValue(input.nativeSessionId);
    if (!nativeSessionId) return;
    const root = await createRootExecution({
      orgId,
      runId: input.runId,
      sourceKey: `root:${input.provider}:${nativeSessionId}`,
      provider: input.provider,
      nativeSessionId,
      status: "running",
    }, exec);
    await advanceExecutionLifecycle({
      orgId,
      runId: input.runId,
      executionId: root.id,
      status: "running",
      attempt: root.attempt,
      eventId: input.id,
      eventRevision: 1,
      deliverySeq,
      ...(root.startedAt == null ? { startedAt: new Date() } : {}),
    }, exec);
    await recoverPendingObservations({
      orgId,
      runId: input.runId,
      provider: input.provider,
      seedParentSessionIds: [nativeSessionId],
      seedChildSessionIds: [nativeSessionId],
      // T3 top-level child events may carry the provider's parent alias while
      // the root is keyed by the product thread. The bounded scan lets the
      // existing explicit /root/<agent> fallback prove those observations.
      includeRunScan: input.provider === "t3",
    }, exec);
    return;
  }

  const structure = observationStructure(input, observation);
  await inTransaction(exec, async (tx) => {
    const staged = await stageExecutionGraphObservation({
      orgId,
      runId: input.runId,
      provider: input.provider,
      providerEventId: input.id,
      deliverySeq,
      structure,
    }, tx);
    if (staged.outcome === "stale" || staged.outcome === "structural_mismatch") return;
    const applied = await applyObservation(orgId, input, deliverySeq, observation, tx);
    if (!applied.applied || !applied.resolutionReason) return;
    await markExecutionGraphObservationApplied({
      id: staged.row.id,
      expectedProviderEventSeq: deliverySeq,
      structure,
      reason: applied.resolutionReason,
    }, tx);
    await recoverPendingObservations({
      orgId,
      runId: input.runId,
      provider: input.provider,
      seedParentSessionIds: applied.wakeParentSessionIds,
      seedChildSessionIds: applied.wakeChildSessionIds,
    }, tx);
  });
}

/** Strict seal-time audit. Replays the latest durable provider rows in bounded
 * pages, reconstructing any pointer missed by fail-open hot-path capture, then
 * rejects unresolved or structurally mismatched graph evidence. */
export async function auditExecutionGraphAtSeal(
  orgId: string,
  runId: string,
  exec: Executor,
  options: { readonly failOnBlockers?: boolean } = {},
): Promise<number> {
  const pageSize = 500;
  let afterSeq = -1;
  let afterId = "";
  while (true) {
    const rows = await exec
      .select()
      .from(providerEvents)
      .where(and(
        eq(providerEvents.runId, runId),
        or(
          gt(providerEvents.seq, afterSeq),
          and(eq(providerEvents.seq, afterSeq), gt(providerEvents.id, afterId)),
        ),
      ))
      .orderBy(asc(providerEvents.seq), asc(providerEvents.id))
      .limit(pageSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!SUPPORTED_PROVIDERS.has(row.provider)) continue;
      const source = providerInputFromRow(row);
      const observation = graphObservation(source.input);
      if (observation) {
        await writeExecutionGraph(source.input, source.seq, exec);
        continue;
      }
      const pointer = await executionGraphPendingObservationBySource({
        orgId,
        runId,
        provider: row.provider,
        providerEventId: row.id,
      }, exec);
      if (!pointer?.latestObservationKind) continue;
      await stageExecutionGraphObservation({
        orgId,
        runId,
        provider: row.provider,
        providerEventId: row.id,
        deliverySeq: row.seq,
        structure: {
          kind: pointer.latestObservationKind,
          nativeParentSessionId: pointer.latestNativeParentSessionId,
          nativeChildSessionId: pointer.latestNativeChildSessionId,
          relevant: false,
          executionRequired: pointer.latestExecutionRequired,
        },
      }, exec);
    }
    afterSeq = rows.at(-1)!.seq;
    afterId = rows.at(-1)!.id;
    if (rows.length < pageSize) break;
  }
  const blockers = await executionGraphSealBlockers(orgId, runId, exec);
  if (blockers.length > 0 && options.failOnBlockers !== false) {
    const mismatch = blockers.some((row) => row.structuralMismatchAt != null);
    throw new Error(mismatch
      ? "execution_graph_structural_revision_mismatch"
      : "execution_graph_pending_unresolved");
  }
  return blockers.length;
}

/** Fail-open shadow writer. It never exposes payloads or rejects provider delivery. */
export async function shadowWriteExecutionGraph(
  input: ProviderEventInput,
  deliverySeq: number,
  exec: Executor = db,
): Promise<void> {
  try {
    await writeExecutionGraph(input, deliverySeq, exec);
  } catch (error) {
    console.warn("[execution-graph-shadow] write failed", {
      runId: input.runId.slice(0, LOG_VALUE_CAP),
      eventId: input.id.slice(0, LOG_VALUE_CAP),
      provider: input.provider.slice(0, LOG_VALUE_CAP),
      eventType: input.eventType.slice(0, LOG_VALUE_CAP),
      error: errorMessage(error).slice(0, LOG_VALUE_CAP),
    });
  }
}
