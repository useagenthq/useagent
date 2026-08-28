import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbTx, Executor } from "../db/client";
import {
  agentExecutions,
  providerEvents,
  type ExecutionStatus,
} from "../db/schema";
import { taskChildSessionId } from "../engines/opencode-child-identity";
import { errorMessage } from "../util/error-message";
import { advanceExecutionLifecycle } from "./execution-graph-repo";
import type { ExecutionGraphRolloutMode } from "./execution-graph-rollout";
import { drainProviderEvents } from "./provider-events";

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
  readonly provider: "opencode";
  readonly nativeParentSessionId: string;
  readonly childSessionId: string;
  readonly status: Extract<ExecutionStatus, "completed" | "failed">;
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
  if (mode !== "off") await drain(runId);
}

/** Reconcile only graph rows that already exist for the finalized run. */
export async function reconcileExecutionGraphAtSeal(
  input: SealInput,
  exec: Executor,
): Promise<void> {
  const executions = await exec
    .select()
    .from(agentExecutions)
    .where(and(
      eq(agentExecutions.orgId, input.orgId),
      eq(agentExecutions.runId, input.runId),
    ));
  if (executions.length === 0) return;

  const [watermarkRows, taskEvents] = await Promise.all([
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
    if (TERMINAL_STATUSES.has(execution.status)) continue;
    const status = execution.provider === "opencode" &&
      execution.nativeParentSessionId &&
      execution.nativeSessionId
      ? explicitTaskStatus.get(taskEvidenceKey({
          provider: execution.provider,
          nativeParentSessionId: execution.nativeParentSessionId,
          childSessionId: execution.nativeSessionId,
        })) ?? "cancelled"
      : "cancelled";
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
  sealEventId,
  taskEvidenceKey,
};
