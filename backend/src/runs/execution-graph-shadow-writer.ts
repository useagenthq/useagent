import { and, eq } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import {
  agentExecutions,
  runs,
  type AgentExecutionRow,
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

const SUPPORTED_PROVIDERS = new Set(["opencode", "pi", "t3"]);
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
): Promise<void> {
  const { payload } = activityPayload(input);
  const nativeSessionId = input.provider === "pi"
    ? stringValue(payload?.childSessionId)
    : stringValue(input.nativeSessionId);
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
    return;
  }

  if (observation.kind === "spawn") {
    const { spawn } = observation;
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
  }

  if (observation.kind === "control") {
    const { control } = observation;
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

  if (observation.kind === "lifecycle") {
    await advanceChild(orgId, input, deliverySeq, exec);
  }
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
