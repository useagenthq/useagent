import { eq } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { runs, type AgentExecutionRow, type ExecutionStatus } from "../db/schema";
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

const SUPPORTED_PROVIDERS = new Set(["opencode", "t3"]);
const CONTROL_KINDS = new Set<ControlDelegationKind>([
  "wait",
  "send",
  "resume",
  "close",
  "gather",
]);
const LOG_VALUE_CAP = 160;

type RecordValue = Record<string, unknown>;

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
  return { activity, payload: recordValue(activity?.payload) };
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
  return executionByNativeSession(
    orgId,
    input.runId,
    input.provider,
    nativeParentSessionId,
    exec,
  );
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
    payload?.delegationKind === "spawn" &&
    (input.eventType.endsWith(".started") || activityPayload(input).activity?.kind === "tool.started")
  ) {
    const childSessionId = stringValue(payload.childSessionId, payload.taskId);
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

async function advanceChild(
  orgId: string,
  input: ProviderEventInput,
  deliverySeq: number,
  exec: Executor,
): Promise<void> {
  const nativeSessionId = stringValue(input.nativeSessionId);
  const status = lifecycleStatus(input);
  if (!nativeSessionId || !status) return;
  const execution = await executionByNativeSession(
    orgId,
    input.runId,
    input.provider,
    nativeSessionId,
    exec,
  );
  if (!execution || execution.mode !== "native_child") return;
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
    ...(status === "running" && execution.startedAt == null ? { startedAt: new Date() } : {}),
    ...(terminal ? { settledAt: new Date() } : {}),
  }, exec);
}

async function writeExecutionGraph(
  input: ProviderEventInput,
  deliverySeq: number,
  exec: Executor,
): Promise<void> {
  if (!SUPPORTED_PROVIDERS.has(input.provider)) return;
  const orgId = await owningOrgId(input.runId, exec);
  if (!orgId) return;

  if (input.eventType === "session.started") {
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
    return;
  }

  const spawn = explicitSpawnIdentity(input);
  if (spawn) {
    const parent = await parentExecution(orgId, input, spawn.parentSessionId, exec);
    if (!parent) return;
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
    await advanceExecutionLifecycle({
      orgId,
      runId: input.runId,
      executionId: spawned.execution.id,
      status: "running",
      attempt: spawned.execution.attempt,
      eventId: input.id,
      eventRevision: 1,
      deliverySeq,
      ...(spawned.execution.startedAt == null ? { startedAt: new Date() } : {}),
    }, exec);
  }

  const control = explicitControl(input);
  if (control) {
    const parent = await parentExecution(orgId, input, control.parentSessionId, exec);
    if (!parent) return;
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
  }

  await advanceChild(orgId, input, deliverySeq, exec);
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
