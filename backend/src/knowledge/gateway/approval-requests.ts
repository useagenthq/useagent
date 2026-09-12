import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { gatewayApprovalRequests } from "../../db/schema";
import { recordProviderEvent } from "../../runs/provider-events";
import { getRunForOrg } from "../../runs/repo";
import { approvalArgumentsHash, mintApprovalCapability } from "./approval-capability";
import { isBotThread } from "../../bots/repo";

// ---------------------------------------------------------------------------
// Durable approval-request lane (#77). The agent records a request for one
// approval-gated gateway operation; a human org member approves or denies it
// through /api/gateway/approvals; the agent polls the one-shot capability out
// and retries the gated tool. This module owns the request STATE MACHINE:
// pending -> approved | denied | expired, every transition guarded by
// `status = 'pending'` so concurrent resolvers race safely, and the parked
// capability is handed out EXACTLY once (`capability` nulled on handout).
// All functions run on the PRIMARY backend (the restricted gateway process
// reaches them through the internal bridge, like automation tools).
// ---------------------------------------------------------------------------

/** How long a request waits for the human before it lapses. */
const REQUEST_TTL_MS = 15 * 60_000;
/** A bot's threads (home or handed off) are standing assignments: their approvals
 *  wait for a person instead of expiring in minutes and leaving the bot silently stuck. */
export const BOT_REQUEST_TTL_MS = 7 * 24 * 60 * 60_000;

async function approvalTtlMs(orgId: string, threadId: string): Promise<number> {
  return (await isBotThread(orgId, threadId)) ? BOT_REQUEST_TTL_MS : REQUEST_TTL_MS;
}
const LIST_LIMIT = 50;

/** Timeline provider lane for approval cards (mirrors "useAgent-knowledge"). */
const EVENT_PROVIDER = "skynet-gateway";

export type ApprovalRequestRecord = typeof gatewayApprovalRequests.$inferSelect;

export interface ApprovalRunGate {
  readonly userId: string | null;
  readonly threadId: string;
  readonly status: string;
}

export type ApprovalDecision = "approve" | "deny";

/** A decision for a run that already settled: the turn that carries it to the agent. */
export interface ApprovalFollowUpInput {
  readonly request: ApprovalRequestRecord;
  readonly decision: ApprovalDecision;
  /** The person who decided; the follow-up turn is theirs. */
  readonly actorId: string;
  readonly reason: string | null;
}

export type ApprovalFollowUpOutcome =
  | { readonly runId: string }
  | { readonly error: string };

export interface ApprovalResolutionDependencies {
  readonly findRun: (orgId: string, runId: string) => Promise<ApprovalRunGate | null>;
  readonly mint: typeof mintApprovalCapability;
  readonly isBotThread?: typeof isBotThread;
  /** Starts the follow-up turn that tells a SETTLED run's thread the decision
   *  (see `approvalDecisionPrompt`). Absent, a settled run stays unapprovable. */
  readonly startFollowUp?: (input: ApprovalFollowUpInput) => Promise<ApprovalFollowUpOutcome>;
}

const defaultResolutionDependencies: ApprovalResolutionDependencies = {
  findRun: getRunForOrg,
  mint: mintApprovalCapability,
};

export type ApprovalResolutionError =
  | "request_not_found"
  | "request_not_pending"
  | "request_expired"
  | "run_not_found"
  | "run_not_active"
  | "run_user_mismatch"
  | "follow_up_failed";

export type ApprovalResolutionResult =
  | {
      readonly ok: true;
      readonly request: ApprovalRequestRecord;
      /** The turn started to carry the decision when the requesting run had settled; null on the live path. */
      readonly followUpRunId: string | null;
    }
  | { readonly ok: false; readonly error: ApprovalResolutionError; readonly detail?: string };

/** Runs that ended: the agent left its turn to wait for the person, as the
 *  approval_request contract tells it to. A queued run cannot have asked yet. */
const SETTLED_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed"]);

/**
 * The follow-up turn's prompt: what the person decided, plus what the agent
 * needs to continue. The request id is what approval_poll takes; the bearer
 * capability itself never rides in a prompt, it reaches only that poll.
 */
export function approvalDecisionPrompt(
  request: Pick<ApprovalRequestRecord, "id" | "toolName">,
  decision: ApprovalDecision,
  reason: string | null,
): string {
  if (decision === "approve") {
    return `Approved ${request.toolName}. Fetch approval ${request.id} with approval_poll, then call ${request.toolName} with the same arguments and finish the task.`;
  }
  const why = reason?.trim() ? ` Reason: ${reason.trim()}` : "";
  return `Denied ${request.toolName} (approval ${request.id}).${why} Do not retry it; continue without it or say what you need.`;
}

/** Approval-card timeline frame. Awaited so the card is durable before the
 *  caller replies, but a capture failure never fails the lane (the durable
 *  request row is the source of truth; recordProviderEvent never rejects). */
async function emitApprovalEvent(
  request: ApprovalRequestRecord,
  state: "requested" | "resolved",
): Promise<void> {
  await recordProviderEvent(
    {
      id: `pe_${request.runId}_gwappr_${request.id}_${state}`,
      runId: request.runId,
      threadId: request.threadId,
      provider: EVENT_PROVIDER,
      eventType: `gateway.approval.${state}`,
      payload: {
        requestId: request.id,
        toolName: request.toolName,
        arguments: request.arguments,
        status: request.status,
        expiresAt: request.expiresAt.toISOString(),
        ...(request.resolvedBy ? { resolvedBy: request.resolvedBy } : {}),
      },
    },
    { critical: true },
  );
}

/** Lazily lapse an overdue pending row. Single transition (`status = 'pending'`
 *  guard), so a concurrent approve/deny and this expiry cannot both win. */
async function expireIfOverdue(
  request: ApprovalRequestRecord,
  now: Date,
): Promise<ApprovalRequestRecord> {
  if (request.status !== "pending" || request.expiresAt > now) return request;
  const [expired] = await db
    .update(gatewayApprovalRequests)
    .set({ status: "expired", resolvedAt: now })
    .where(
      and(
        eq(gatewayApprovalRequests.id, request.id),
        eq(gatewayApprovalRequests.status, "pending"),
      ),
    )
    .returning();
  return expired ?? (await getApprovalRequest(request.orgId, request.id)) ?? request;
}

async function getApprovalRequest(
  orgId: string,
  id: string,
): Promise<ApprovalRequestRecord | null> {
  const [row] = await db
    .select()
    .from(gatewayApprovalRequests)
    .where(
      and(eq(gatewayApprovalRequests.id, id), eq(gatewayApprovalRequests.orgId, orgId)),
    )
    .limit(1);
  return row ?? null;
}

/** Org-scoped read with lazy expiry applied. */
export async function getApprovalRequestForOrg(
  orgId: string,
  id: string,
  now = new Date(),
): Promise<ApprovalRequestRecord | null> {
  const row = await getApprovalRequest(orgId, id);
  return row ? expireIfOverdue(row, now) : null;
}

/**
 * Record a durable approval request and surface it on the run timeline.
 * Idempotent against agent retries: an existing PENDING request for the same
 * run + tool + exact normalized arguments is returned instead of duplicated.
 */
export async function createApprovalRequest(
  input: {
    readonly orgId: string;
    readonly runId: string;
    readonly threadId: string;
    readonly toolName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  },
  now = new Date(),
): Promise<{ readonly request: ApprovalRequestRecord; readonly created: boolean }> {
  const argumentsHash = approvalArgumentsHash(input.arguments);
  const [existing] = await db
    .select()
    .from(gatewayApprovalRequests)
    .where(
      and(
        eq(gatewayApprovalRequests.orgId, input.orgId),
        eq(gatewayApprovalRequests.runId, input.runId),
        eq(gatewayApprovalRequests.toolName, input.toolName),
        eq(gatewayApprovalRequests.argumentsHash, argumentsHash),
        eq(gatewayApprovalRequests.status, "pending"),
        gt(gatewayApprovalRequests.expiresAt, now),
      ),
    )
    .limit(1);
  if (existing) return { request: existing, created: false };

  const [request] = await db
    .insert(gatewayApprovalRequests)
    .values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      runId: input.runId,
      threadId: input.threadId,
      toolName: input.toolName,
      arguments: { ...input.arguments },
      argumentsHash,
      status: "pending",
      requestedAt: now,
      expiresAt: new Date(now.getTime() + (await approvalTtlMs(input.orgId, input.threadId))),
    })
    .returning();
  if (!request) throw new Error("failed to record gateway approval request");
  await emitApprovalEvent(request, "requested");
  return { request, created: true };
}

export interface ApprovalListScope {
  readonly orgId: string;
  readonly runId?: string;
  readonly threadId?: string;
  /** Default: every status, so a reloaded thread keeps its resolved cards. */
  readonly status?: "pending";
}

/** Requests for one run or thread (org-scoped, lazily expired). Serves resolved
 *  rows too: approvals are part of the thread's history, not only its live state. */
export async function listApprovalRequests(
  scope: ApprovalListScope,
  now = new Date(),
): Promise<readonly ApprovalRequestRecord[]> {
  if (!scope.runId && !scope.threadId) return [];
  const inScope = scope.runId
    ? eq(gatewayApprovalRequests.runId, scope.runId)
    : eq(gatewayApprovalRequests.threadId, scope.threadId ?? "");
  await db
    .update(gatewayApprovalRequests)
    .set({ status: "expired", resolvedAt: now })
    .where(
      and(
        eq(gatewayApprovalRequests.orgId, scope.orgId),
        eq(gatewayApprovalRequests.status, "pending"),
        lte(gatewayApprovalRequests.expiresAt, now),
        inScope,
      ),
    );
  return db
    .select()
    .from(gatewayApprovalRequests)
    .where(
      and(
        eq(gatewayApprovalRequests.orgId, scope.orgId),
        inScope,
        ...(scope.status ? [eq(gatewayApprovalRequests.status, scope.status)] : []),
      ),
    )
    .orderBy(desc(gatewayApprovalRequests.requestedAt))
    .limit(LIST_LIMIT);
}

type ResolutionGate =
  | { readonly error: ApprovalResolutionError }
  | {
      readonly error?: undefined;
      /** The requesting run ended: the decision reaches the agent through a follow-up turn. */
      readonly settled: boolean;
    };

/** The mint route's exact gate, applied to a stored request row: the target run
 *  must be live or settled (never merely queued) and belong to the resolver. */
async function gateResolution(
  request: ApprovalRequestRecord,
  resolvedBy: string,
  deps: ApprovalResolutionDependencies,
  now: Date,
): Promise<ResolutionGate> {
  const lapsed = await expireIfOverdue(request, now);
  if (lapsed.status === "expired" && request.status === "pending") return { error: "request_expired" };
  if (lapsed.status !== "pending") return { error: "request_not_pending" };
  const run = await deps.findRun(request.orgId, request.runId);
  if (!run) return { error: "run_not_found" };
  const settled = SETTLED_RUN_STATUSES.has(run.status);
  if (run.status !== "running" && !settled) return { error: "run_not_active" };
  // A settled run can only be continued through a follow-up turn; a resolver
  // without that path (the operator loopback) keeps the live-only rule.
  if (settled && !deps.startFollowUp) return { error: "run_not_active" };
  if (request.threadId !== run.threadId) return { error: "run_user_mismatch" };
  // A run started by a person is that person's to approve. A bot's unattended run (a
  // routine firing, or a handoff from one) belongs to the org: any member who reached this
  // org-scoped route may act. Other userless runs (an unmapped Slack user) stay unapprovable.
  if (run.userId === resolvedBy) return { settled };
  if (
    run.userId === null &&
    (await (deps.isBotThread ?? isBotThread)(request.orgId, run.threadId))
  ) {
    return { settled };
  }
  return { error: "run_user_mismatch" };
}

/** For a settled run: the follow-up turn that will consume the decision. */
async function followUpForSettledRun(
  gate: ResolutionGate,
  input: ApprovalFollowUpInput,
  deps: ApprovalResolutionDependencies,
): Promise<ApprovalFollowUpOutcome | null> {
  if (gate.error || !gate.settled || !deps.startFollowUp) return null;
  return deps.startFollowUp(input);
}

/**
 * Approve: mint the one-shot capability (same mint as POST /api/gateway/approvals)
 * and park it on the row for the agent's poll. Race-safe: the transition updates
 * only a still-pending row, so exactly one of any concurrent resolutions wins;
 * a loser's freshly minted capability is never referenced and simply expires in
 * the single-use ledger.
 *
 * A request whose run already SETTLED (the agent ended its turn to wait, as the
 * approval_request contract says) is decided the same way, but the capability
 * is bound to a follow-up turn started on the thread first: the row is
 * re-pointed at that run so its approval_poll receives the capability, while
 * the card stays on the turn that asked.
 */
export async function approveApprovalRequest(
  input: { readonly orgId: string; readonly requestId: string; readonly approvedBy: string },
  deps: ApprovalResolutionDependencies = defaultResolutionDependencies,
  now = new Date(),
): Promise<ApprovalResolutionResult> {
  const request = await getApprovalRequest(input.orgId, input.requestId);
  if (!request) return { ok: false, error: "request_not_found" };
  const gate = await gateResolution(request, input.approvedBy, deps, now);
  if (gate.error) return { ok: false, error: gate.error };
  const followUp = await followUpForSettledRun(
    gate,
    { request, decision: "approve", actorId: input.approvedBy, reason: null },
    deps,
  );
  if (followUp && "error" in followUp) {
    return { ok: false, error: "follow_up_failed", detail: followUp.error };
  }
  const consumerRunId = followUp?.runId ?? request.runId;

  const minted = await deps.mint({
    orgId: request.orgId,
    userId: input.approvedBy,
    threadId: request.threadId,
    runId: consumerRunId,
    toolName: request.toolName,
    arguments: request.arguments,
  });
  const [approved] = await db
    .update(gatewayApprovalRequests)
    .set({
      status: "approved",
      runId: consumerRunId,
      capability: minted.capability,
      capabilityExpiresAt: minted.expiresAt,
      resolvedAt: now,
      resolvedBy: input.approvedBy,
    })
    .where(
      and(
        eq(gatewayApprovalRequests.id, request.id),
        eq(gatewayApprovalRequests.status, "pending"),
      ),
    )
    .returning();
  if (!approved) return { ok: false, error: "request_not_pending" };
  // The card lives on the turn that asked, whichever run consumes the capability.
  await emitApprovalEvent({ ...approved, runId: request.runId }, "resolved");
  return { ok: true, request: approved, followUpRunId: followUp?.runId ?? null };
}

/** Deny: same gate and single pending->denied transition, no capability. A
 *  settled run's thread gets a follow-up turn carrying the denial and its reason. */
export async function denyApprovalRequest(
  input: {
    readonly orgId: string;
    readonly requestId: string;
    readonly deniedBy: string;
    readonly reason?: string | null;
  },
  deps: ApprovalResolutionDependencies = defaultResolutionDependencies,
  now = new Date(),
): Promise<ApprovalResolutionResult> {
  const request = await getApprovalRequest(input.orgId, input.requestId);
  if (!request) return { ok: false, error: "request_not_found" };
  const gate = await gateResolution(request, input.deniedBy, deps, now);
  if (gate.error) return { ok: false, error: gate.error };
  const followUp = await followUpForSettledRun(
    gate,
    { request, decision: "deny", actorId: input.deniedBy, reason: input.reason ?? null },
    deps,
  );
  if (followUp && "error" in followUp) {
    return { ok: false, error: "follow_up_failed", detail: followUp.error };
  }

  const [denied] = await db
    .update(gatewayApprovalRequests)
    .set({
      status: "denied",
      runId: followUp?.runId ?? request.runId,
      resolvedAt: now,
      resolvedBy: input.deniedBy,
    })
    .where(
      and(
        eq(gatewayApprovalRequests.id, request.id),
        eq(gatewayApprovalRequests.status, "pending"),
      ),
    )
    .returning();
  if (!denied) return { ok: false, error: "request_not_pending" };
  await emitApprovalEvent({ ...denied, runId: request.runId }, "resolved");
  return { ok: true, request: denied, followUpRunId: followUp?.runId ?? null };
}

/**
 * One-shot capability handout for the requesting agent: atomically clears the
 * parked capability so concurrent polls deliver it at most once. Bound to the
 * exact requesting run - a different run's poll never receives it.
 */
export async function takeApprovalCapability(input: {
  readonly orgId: string;
  readonly runId: string;
  readonly requestId: string;
}): Promise<{ readonly capability: string; readonly expiresAt: Date | null } | null> {
  // RETURNING reflects the row AFTER the update, so the parked value must be
  // captured through a locked pre-image subquery: the row lock makes clearing
  // and reading atomic, and concurrent polls serialize on it - exactly one
  // caller sees a non-null pre-image.
  const rows = (await db.execute(sql`
    update gateway_approval_requests as request
    set capability = null
    from (
      select id, capability, capability_expires_at
      from gateway_approval_requests
      where id = ${input.requestId}
        and org_id = ${input.orgId}
        and run_id = ${input.runId}
        and status = 'approved'
        and capability is not null
      for update
    ) parked
    where request.id = parked.id
    returning parked.capability as capability,
      parked.capability_expires_at as capability_expires_at
  `)) as Array<{ capability: string | null; capability_expires_at: unknown }>;
  const handout = rows[0];
  if (!handout?.capability) return null;
  const rawExpiry = handout.capability_expires_at;
  const expiresAt =
    rawExpiry instanceof Date ? rawExpiry : rawExpiry ? new Date(String(rawExpiry)) : null;
  return { capability: handout.capability, expiresAt };
}

/**
 * Loopback operator hook (release-lane parity canary acting as the human):
 * approve one request AS the target run's owner. Same gate as the session
 * route - the run must still be active - only the resolver identity is taken
 * from the run row instead of a browser session.
 */
export async function approveApprovalRequestAsRunOwner(
  requestId: string,
): Promise<{ readonly approved: boolean; readonly error?: string }> {
  const [request] = await db
    .select()
    .from(gatewayApprovalRequests)
    .where(eq(gatewayApprovalRequests.id, requestId))
    .limit(1);
  if (!request) return { approved: false, error: "request_not_found" };
  const run = await getRunForOrg(request.orgId, request.runId);
  if (!run?.userId) return { approved: false, error: "run_not_found" };
  const result = await approveApprovalRequest({
    orgId: request.orgId,
    requestId,
    approvedBy: run.userId,
  });
  return result.ok ? { approved: true } : { approved: false, error: result.error };
}

/** API projection - never exposes the parked capability. */
export function approvalRequestSummary(
  request: ApprovalRequestRecord,
): Record<string, unknown> {
  return {
    id: request.id,
    run_id: request.runId,
    thread_id: request.threadId,
    tool_name: request.toolName,
    arguments: request.arguments,
    status: request.status,
    requested_at: request.requestedAt.toISOString(),
    expires_at: request.expiresAt.toISOString(),
    resolved_at: request.resolvedAt?.toISOString() ?? null,
    resolved_by: request.resolvedBy,
  };
}

export const APPROVAL_REQUEST_TTL_MS = REQUEST_TTL_MS;
