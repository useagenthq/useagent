import type { PermissionMode } from "@useagent/agent-client/wire";
import { SANDBOX_NAME_PREFIX } from "../sandboxes/sandbox-names";
import { resolvePreviewSandbox } from "../runs/preview-proxy";
import { approvalDecisionAllowed, readOnlyRefusal } from "./permission-mode";
import { resolveExpectedSandbox } from "../sandboxes/binding";
import type { ExpectedSandboxBinding } from "../sandboxes/expected-binding";
import { providerEventExists, recordProviderEvent } from "../runs/provider-events";
import { requestRuntimeEnvironment } from "./runtime-environment-client";
import { dispatchRuntimeCommand } from "./runtime-dispatch";
import { readRuntimeThreadView } from "./runtime-thread-read";
import { buildV2RuntimeRequestRespond } from "./runtime-v2-wire";
import type { EmitStep } from "./types";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";

const RUNTIME_APPROVAL_TIMEOUT_MS = 15_000;

export function resolveRuntimeApprovalSandbox(
  threadId: string,
  expectedSandbox: ExpectedSandboxBinding | null | undefined,
  dependencies = {
    expected: resolveExpectedSandbox,
    preview: resolvePreviewSandbox,
  },
) {
  return expectedSandbox
    ? dependencies.expected(expectedSandbox, threadId)
    : dependencies.preview(threadId);
}

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
    readonly status: 400 | 403 | 409 | 502 | 503,
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
  state: "requested" | "responding" | "responded" | "resolved",
): string {
  return `pe_${runId}_${requestId}_approval_${state}`;
}

/** What the reply path talks to; a test hands in fakes for the runtime and the ledger. */
export interface RuntimeApprovalReplyDependencies {
  readonly resolveSandbox: typeof resolveRuntimeApprovalSandbox;
  readonly request: typeof requestRuntimeEnvironment;
  readonly dispatch: typeof dispatchRuntimeCommand;
  readonly recordEvent: typeof recordProviderEvent;
  readonly eventExists: typeof providerEventExists;
}

export function runtimeApprovalRequest(
  activity: RuntimeThreadSnapshot["thread"]["activities"][number],
  sessionId: string,
): RuntimeApprovalRequest | null {
  if (activity.kind !== "approval.requested") return null;
  const payload = record(activity.payload);
  if (typeof payload?.requestId !== "string") return null;
  return {
    id: payload.requestId,
    sessionID: sessionId,
    requestKind: approvalRequestKind(payload.requestKind),
    ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
  };
}

function approvalRequestKind(value: unknown): RuntimeApprovalRequest["requestKind"] {
  return value === "command" || value === "file-read" || value === "file-change" ? value : "other";
}

/** The request a recorded `approval.requested` ledger event describes: its
 *  payload is the RuntimeApprovalRequest the lane stored (see
 *  runtimeActivityProviderEvent), keyed by `id` where the runtime's own
 *  activity says `requestId`. Null for any other payload. */
export function recordedApprovalRequest(payload: unknown, sessionId: string): RuntimeApprovalRequest | null {
  const stored = record(payload);
  if (typeof stored?.id !== "string") return null;
  return {
    id: stored.id,
    sessionID: sessionId,
    requestKind: approvalRequestKind(stored.requestKind),
    ...(typeof stored.detail === "string" ? { detail: stored.detail } : {}),
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
  readonly expectedSandbox?: ExpectedSandboxBinding | null;
  /** The run's permission policy: a read-only run never lets a command or file change through. */
  readonly permissionMode: PermissionMode;
}, dependencies: Partial<RuntimeApprovalReplyDependencies> = {}): Promise<{ alreadyAnswered: boolean }> {
  const resolveSandbox = dependencies.resolveSandbox ?? resolveRuntimeApprovalSandbox;
  const request = dependencies.request ?? requestRuntimeEnvironment;
  const dispatch = dependencies.dispatch ?? dispatchRuntimeCommand;
  const recordEvent = dependencies.recordEvent ?? recordProviderEvent;
  const eventExists = dependencies.eventExists ?? providerEventExists;
  const respondedEventId = approvalEventId(input.runId, input.requestId, "responded");
  if (await eventExists(respondedEventId)) return { alreadyAnswered: true };

  const decision = validateRuntimeApprovalDecision(input.decision);
  const sandbox = await resolveSandbox(input.threadId, input.expectedSandbox);
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(RUNTIME_APPROVAL_TIMEOUT_MS)]);
  const snapshot = await readRuntimeThreadView(sandbox, input.sessionId, signal, request);
  const pending = assertRuntimeApprovalPending(snapshot, input.sessionId, input.requestId);
  if (!approvalDecisionAllowed(input.permissionMode, pending, decision)) {
    throw new RuntimeApprovalError(
      "approval_refused_read_only",
      403,
      "this run is read-only: a request to run a command or change files can only be declined",
    );
  }
  if (decision === "acceptForSession") {
    // A grant the runtime keeps for the whole session must be known to us before
    // it can exist there: the intent is durable first, in its own write, and only
    // then dispatched. Should the receipt below fail to persist, the intent still
    // says a grant may stand, and a later read-only turn refuses the thread.
    await recordEvent({
      id: approvalEventId(input.runId, input.requestId, "responding"),
      runId: input.runId,
      threadId: input.threadId,
      provider: "t3",
      eventType: "approval.responding",
      nativeSessionId: input.sessionId,
      payload: { requestId: input.requestId, decision },
    }, { required: true });
  }
  await dispatch(sandbox, {
    ...buildV2RuntimeRequestRespond({
      commandId: `${SANDBOX_NAME_PREFIX}-approval-${crypto.randomUUID()}`,
      threadId: input.sessionId,
      requestId: input.requestId,
      decision,
    }),
    threadId: input.sessionId,
  }, signal);
  await recordEvent({
    id: respondedEventId,
    runId: input.runId,
    threadId: input.threadId,
    provider: "t3",
    eventType: "approval.responded",
    nativeSessionId: input.sessionId,
    payload: { requestId: input.requestId, decision },
  }, { critical: true });
  if (!(await eventExists(respondedEventId))) {
    throw new RuntimeApprovalError(
      "approval_persist_failed",
      503,
      "the approval reached the provider runtime but its durable receipt could not be recorded",
    );
  }
  return { alreadyAnswered: false };
}

export type RuntimeApprovalReply = typeof replyToRuntimeApproval;

/** For a read-only run, answer one of the runtime's approval requests: a command
 *  or file change is declined through the same reply path a person uses
 *  (idempotent on the responded receipt) and a read passes. The live observer
 *  and the restart recovery loop both come through here. Returns the step that
 *  records the refusal, or null when the request may proceed. */
export async function refuseReadOnlyRequest(
  input: {
    readonly runId: string;
    readonly threadId: string;
    readonly sessionId: string;
    readonly request: RuntimeApprovalRequest;
    readonly signal: AbortSignal;
    readonly expectedSandbox: ExpectedSandboxBinding | null;
  },
  reply: RuntimeApprovalReply = replyToRuntimeApproval,
): Promise<{ step: EmitStep; alreadyAnswered: boolean } | null> {
  const refusal = readOnlyRefusal(input.request);
  if (!refusal) return null;
  const { alreadyAnswered } = await reply({
    runId: input.runId,
    threadId: input.threadId,
    sessionId: input.sessionId,
    requestId: input.request.id,
    decision: "decline",
    signal: input.signal,
    expectedSandbox: input.expectedSandbox,
    permissionMode: "read-only",
  });
  return {
    step: { kind: "task", label: `Refused to ${refusal}: this run is read-only`, chip: "read-only" },
    alreadyAnswered,
  };
}
