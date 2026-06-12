import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbTx, type Executor } from "../db/client";
import {
  agentExecutions,
  providerEvents,
  runs,
  type ExecutionStatus,
} from "../db/schema";
import { taskChildSessionId } from "../engines/opencode-child-identity";
import { errorMessage } from "../util/error-message";
import { advanceExecutionLifecycle } from "./execution-graph-repo";
import type { ExecutionGraphRolloutMode } from "./execution-graph-rollout";
import { drainProviderEvents } from "./provider-events";
import { auditExecutionGraphAtSeal } from "./execution-graph-shadow-writer";
import { executionGraphSealBlockers } from "./execution-graph-pending-repo";

const TERMINAL_STATUSES = new Set<ExecutionStatus>(["completed", "failed", "cancelled"]);
const SEAL_EVENT_REVISION = Number.MAX_SAFE_INTEGER;
const LOG_VALUE_CAP = 160;

type RunTerminalStatus = "completed" | "failed";

interface SealInput {
  readonly orgId: string;
  readonly runId: string;
  readonly status: RunTerminalStatus;
}

interface ParsedTaskEvidence {
  readonly provider: "opencode" | "t3";
  readonly nativeParentSessionId: string;
  readonly childSessionId: string;
  readonly status: ExecutionStatus;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseTaskEvidence(
  eventType: string,
  payloadText: string | null,
  nativeParentSessionId: string | null,
): ParsedTaskEvidence | null {
  if (eventType !== "part.tool.completed" && eventType !== "part.tool.error") return null;
  if (!payloadText || !nativeParentSessionId) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }
  const part = recordValue(payload);
  if (part?.type !== "tool" || part.tool !== "task") return null;
  const state = recordValue(part.state);
  if (!state) return null;
  const childSessionId = taskChildSessionId(state);
  if (!childSessionId) return null;
  return {
    provider: "opencode",
    nativeParentSessionId,
    childSessionId,
    status: eventType === "part.tool.completed" ? "completed" : "failed",
  };
}

function parseT3TurnEvidence(
  eventType: string,
  payloadText: string | null,
  nativeSessionId: string | null,
  nativeParentSessionId: string | null,
): ParsedTaskEvidence | null {
  if (eventType !== "t3.activity.task.updated") return null;
  if (!payloadText || !nativeSessionId || !nativeParentSessionId) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }
  const activity = recordValue(payload);
  const task = recordValue(activity?.payload);
  const activityId = typeof activity?.id === "string" ? activity.id : "";
  const prefix = `codex-collab:${nativeSessionId}:turnLifecycle:`;
  if (!activityId.startsWith(prefix) || activityId.length === prefix.length) return null;
  if (task?.agentKind !== "agent" || task.taskId !== nativeSessionId) return null;
  const rawStatus = typeof task.status === "string" ? task.status.toLowerCase() : "";
  const status =
    rawStatus === "idle"
      ? ("completed" as const)
      : rawStatus === "failed"
        ? ("failed" as const)
        : rawStatus === "interrupted" || rawStatus === "cancelled" || rawStatus === "canceled"
          ? ("cancelled" as const)
          : rawStatus === "running"
            ? ("running" as const)
            : null;
  return status
    ? { provider: "t3", nativeParentSessionId, childSessionId: nativeSessionId, status }
    : null;
}

function taskEvidenceKey(input: {
  readonly provider: string;
  readonly nativeParentSessionId: string;
  readonly childSessionId: string;
}): string {
  return JSON.stringify([
    input.provider,
    input.nativeParentSessionId,
    input.childSessionId,
  ]);
}

function sealEventId(runId: string, watermark: number): string {
  return `execution-graph-seal:${runId}:${watermark}`;
}

export async function prepareExecutionGraphSeal(
  runId: string,
  mode: ExecutionGraphRolloutMode,
  drain: (id: string) => Promise<void> = drainProviderEvents,
): Promise<void> {
  if (mode === "off") return;
  await drain(runId);
  const [run] = await db.select({ orgId: runs.orgId }).from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run?.orgId) return;
  // Persist reconstruction/mismatch evidence before the parent finalization
  // transaction. READ can then fail closed without rolling that evidence back.
  await db.transaction((tx) => auditExecutionGraphAtSeal(run.orgId!, runId, tx, {
    failOnBlockers: false,
  }));
  if (mode === "read") {
    const blockers = await executionGraphSealBlockers(run.orgId, runId);
    if (blockers.length > 0) {
      throw new Error(blockers.some((row) => row.structuralMismatchAt != null)
        ? "execution_graph_structural_revision_mismatch"
        : "execution_graph_pending_unresolved");
    }
  }
}

/** Reconcile only graph rows that already exist for the finalized run. */
export async function reconcileExecutionGraphAtSeal(
  input: SealInput,
  exec: Executor,
): Promise<void> {
  await auditExecutionGraphAtSeal(input.orgId, input.runId, exec);
  const executions = await exec
    .select()
    .from(agentExecutions)
    .where(and(
      eq(agentExecutions.orgId, input.orgId),
      eq(agentExecutions.runId, input.runId),
    ));
  if (executions.length === 0) return;

  const [watermarkRows, taskEvents, t3TurnEvents] = await Promise.all([
    exec
      .select({ maxSeq: sql<number | null>`max(${providerEvents.seq})` })
      .from(providerEvents)
      .where(eq(providerEvents.runId, input.runId)),
    exec
      .select({
        seq: providerEvents.seq,
        eventType: providerEvents.eventType,
        nativeParentSessionId: providerEvents.nativeSessionId,
        payload: providerEvents.payload,
      })
      .from(providerEvents)
      .where(and(
        eq(providerEvents.runId, input.runId),
        eq(providerEvents.provider, "opencode"),
        inArray(providerEvents.eventType, ["part.tool.completed", "part.tool.error"]),
      ))
      .orderBy(asc(providerEvents.seq)),
    exec
      .select({
        seq: providerEvents.seq,
        eventType: providerEvents.eventType,
        nativeSessionId: providerEvents.nativeSessionId,
        nativeParentSessionId: providerEvents.nativeParentSessionId,
        payload: providerEvents.payload,
      })
      .from(providerEvents)
      .where(and(
        eq(providerEvents.runId, input.runId),
        eq(providerEvents.provider, "t3"),
        eq(providerEvents.eventType, "t3.activity.task.updated"),
      ))
      .orderBy(asc(providerEvents.seq)),
  ]);
  const watermark = Math.max(0, watermarkRows[0]?.maxSeq ?? 0);
  const eventId = sealEventId(input.runId, watermark);
  const explicitTaskStatus = new Map<string, ParsedTaskEvidence["status"]>();
  for (const event of taskEvents) {
    const evidence = parseTaskEvidence(
      event.eventType,
      event.payload,
      event.nativeParentSessionId,
    );
    if (evidence) explicitTaskStatus.set(taskEvidenceKey(evidence), evidence.status);
  }
  for (const event of t3TurnEvents) {
    const evidence = parseT3TurnEvidence(
      event.eventType,
      event.payload,
      event.nativeSessionId,
      event.nativeParentSessionId,
    );
    if (evidence) explicitTaskStatus.set(taskEvidenceKey(evidence), evidence.status);
  }
  const settledAt = new Date();

  for (const execution of executions) {
    if (execution.mode === "root") {
      // The owning run's first terminal commit is authoritative for its root
      // execution, including cancellation winning a coincident provider success.
      await exec
        .update(agentExecutions)
        .set({
          status: input.status,
          lastEventId: eventId,
          lastEventRevision: SEAL_EVENT_REVISION,
          lastDeliverySeq: sql`greatest(${agentExecutions.lastDeliverySeq}, ${watermark})`,
          settledAt,
          updatedAt: settledAt,
        })
        .where(and(
          eq(agentExecutions.orgId, input.orgId),
          eq(agentExecutions.runId, input.runId),
          eq(agentExecutions.id, execution.id),
          eq(agentExecutions.mode, "root"),
        ));
      continue;
    }
    const observedStatus = execution.nativeParentSessionId && execution.nativeSessionId
      ? explicitTaskStatus.get(taskEvidenceKey({
          provider: execution.provider,
          nativeParentSessionId: execution.nativeParentSessionId,
          childSessionId: execution.nativeSessionId,
        }))
      : undefined;
    const status = observedStatus && TERMINAL_STATUSES.has(observedStatus)
      ? observedStatus
      : "cancelled";
    if (execution.provider === "t3" && observedStatus) {
      // A Codex child thread is resumable. Earlier turns may already have
      // produced failed/cancelled hot-path verdicts that must not dominate the
      // latest exact turnLifecycle evidence at the parent seal.
      await exec
        .update(agentExecutions)
        .set({
          status,
          lastEventId: eventId,
          lastEventRevision: SEAL_EVENT_REVISION,
          lastDeliverySeq: sql`greatest(${agentExecutions.lastDeliverySeq}, ${watermark})`,
          settledAt,
          updatedAt: settledAt,
        })
        .where(and(
          eq(agentExecutions.orgId, input.orgId),
          eq(agentExecutions.runId, input.runId),
          eq(agentExecutions.id, execution.id),
          eq(agentExecutions.mode, "native_child"),
          eq(agentExecutions.provider, "t3"),
        ));
      continue;
    }
    if (TERMINAL_STATUSES.has(execution.status)) continue;
    await advanceExecutionLifecycle({
      orgId: input.orgId,
      runId: input.runId,
      executionId: execution.id,
      status,
      attempt: execution.attempt,
      eventId,
      eventRevision: SEAL_EVENT_REVISION,
      deliverySeq: watermark,
      settledAt,
    }, exec);
  }
}

interface SealPolicyOptions {
  readonly reconcile?: typeof reconcileExecutionGraphAtSeal;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

/** Apply strict READ semantics or fail-open SHADOW semantics inside finalization. */
export async function sealExecutionGraphAfterFinalizeTx(
  input: SealInput & { readonly mode: Exclude<ExecutionGraphRolloutMode, "off"> },
  tx: DbTx,
  options: SealPolicyOptions = {},
): Promise<void> {
  const reconcile = options.reconcile ?? reconcileExecutionGraphAtSeal;
  if (input.mode === "read") {
    await reconcile(input, tx);
    return;
  }
  try {
    await tx.transaction((savepoint) => reconcile(input, savepoint));
  } catch (error) {
    (options.warn ?? ((message, context) => console.warn(message, context)))(
      "[execution-graph-seal] shadow reconciliation failed",
      {
        runId: input.runId.slice(0, LOG_VALUE_CAP),
        error: errorMessage(error).slice(0, LOG_VALUE_CAP),
      },
    );
  }
}

export const executionGraphSealInternals = {
  parseTaskEvidence,
  parseT3TurnEvidence,
  sealEventId,
  taskEvidenceKey,
};
