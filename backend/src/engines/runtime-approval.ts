import { resolvePreviewSandbox } from "../runs/preview-proxy";
import { providerEventExists, recordProviderEvent } from "../runs/provider-events";
import { requestRuntimeEnvironment } from "./runtime-environment-client";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";

const RUNTIME_APPROVAL_TIMEOUT_MS = 15_000;

export const RUNTIME_APPROVAL_DECISIONS = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
] as const;

export type RuntimeApprovalDecision = (typeof RUNTIME_APPROVAL_DECISIONS)[number];

export interface RuntimeApprovalRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly requestKind: "command" | "file-read" | "file-change" | "other";
  readonly detail?: string;
}

export class RuntimeApprovalError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 409 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function approvalEventId(
  runId: string,
  requestId: string,
  state: "requested" | "responded" | "resolved",
): string {
  return `pe_${runId}_${requestId}_approval_${state}`;
}

export function runtimeApprovalRequest(
  activity: RuntimeThreadSnapshot["thread"]["activities"][number],
  sessionId: string,
): RuntimeApprovalRequest | null {
  if (activity.kind !== "approval.requested") return null;
  const payload = record(activity.payload);
  if (typeof payload?.requestId !== "string") return null;
  const rawKind = payload.requestKind;
  const requestKind =
    rawKind === "command" || rawKind === "file-read" || rawKind === "file-change"
      ? rawKind
      : "other";
  return {
    id: payload.requestId,
    sessionID: sessionId,
    requestKind,
    ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
  };
}

export function validateRuntimeApprovalDecision(value: unknown): RuntimeApprovalDecision {
  if (typeof value === "string" && RUNTIME_APPROVAL_DECISIONS.includes(value as RuntimeApprovalDecision)) {
    return value as RuntimeApprovalDecision;
  }
  throw new RuntimeApprovalError(
    "approval_decision_invalid",
    400,
    `decision must be one of: ${RUNTIME_APPROVAL_DECISIONS.join(", ")}`,
  );
}

export function assertRuntimeApprovalPending(
  snapshot: RuntimeThreadSnapshot,
  sessionId: string,
  requestId: string,
): RuntimeApprovalRequest {
  const requestedAt = snapshot.thread.activities.findLastIndex((activity) => {
    const payload = record(activity.payload);
    return activity.kind === "approval.requested" && payload?.requestId === requestId;
  });
  const activity = requestedAt >= 0 ? snapshot.thread.activities[requestedAt] : undefined;
  const request = activity ? runtimeApprovalRequest(activity, sessionId) : null;
  const resolved = snapshot.thread.activities.slice(requestedAt + 1).some((candidate) => {
    const payload = record(candidate.payload);
    return candidate.kind === "approval.resolved" && payload?.requestId === requestId;
  });
  if (!request || resolved) {
    throw new RuntimeApprovalError(
      "approval_not_pending",
      409,
      "this approval is no longer pending on the active provider session",
    );
  }
  return request;
}

export async function replyToRuntimeApproval(input: {
  readonly runId: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly decision: unknown;
  readonly signal: AbortSignal;
}): Promise<{ alreadyAnswered: boolean }> {
  const respondedEventId = approvalEventId(input.runId, input.requestId, "responded");
  if (await providerEventExists(respondedEventId)) return { alreadyAnswered: true };

  const decision = validateRuntimeApprovalDecision(input.decision);
  const sandbox = await resolvePreviewSandbox(input.threadId);
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(RUNTIME_APPROVAL_TIMEOUT_MS)]);
  const snapshot = await requestRuntimeEnvironment<RuntimeThreadSnapshot>(
    sandbox,
    {
      method: "GET",
      path: `/api/orchestration/threads/${encodeURIComponent(input.sessionId)}`,
    },
    signal,
  );
  assertRuntimeApprovalPending(snapshot, input.sessionId, input.requestId);
  await requestRuntimeEnvironment(
    sandbox,
    {
      method: "POST",
      path: "/api/orchestration/dispatch",
      payload: {
        type: "thread.approval.respond",
        commandId: `skynet-approval-${crypto.randomUUID()}`,
        threadId: input.sessionId,
        requestId: input.requestId,
        decision,
        createdAt: new Date().toISOString(),
      },
    },
    signal,
  );
  await recordProviderEvent({
    id: respondedEventId,
    runId: input.runId,
    threadId: input.threadId,
    provider: "t3",
    eventType: "approval.responded",
    nativeSessionId: input.sessionId,
    payload: { requestId: input.requestId, decision },
  }, { critical: true });
  if (!(await providerEventExists(respondedEventId))) {
    throw new RuntimeApprovalError(
      "approval_persist_failed",
      503,
      "the approval reached the provider runtime but its durable receipt could not be recorded",
    );
  }
  return { alreadyAnswered: false };
}
