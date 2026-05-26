import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { gatewayApprovalRequests } from "../../db/schema";
import { recordProviderEvent } from "../../runs/provider-events";
import { getRunForOrg } from "../../runs/repo";
import { approvalArgumentsHash, mintApprovalCapability } from "./approval-capability";

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
const LIST_LIMIT = 50;

/** Timeline provider lane for approval cards (mirrors "skynet-knowledge"). */
const EVENT_PROVIDER = "skynet-gateway";

export type ApprovalRequestRecord = typeof gatewayApprovalRequests.$inferSelect;

export interface ApprovalRunGate {
  readonly userId: string | null;
  readonly status: string;
}

export interface ApprovalResolutionDependencies {
  readonly findRun: (orgId: string, runId: string) => Promise<ApprovalRunGate | null>;
  readonly mint: typeof mintApprovalCapability;
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
  | "run_user_mismatch";

export type ApprovalResolutionResult =
  | { readonly ok: true; readonly request: ApprovalRequestRecord }
  | { readonly ok: false; readonly error: ApprovalResolutionError };

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
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    })
    .returning();
  if (!request) throw new Error("failed to record gateway approval request");
  await emitApprovalEvent(request, "requested");
  return { request, created: true };
}

/** Pending requests for one run or thread (org-scoped, lazily expired). */
export async function listPendingApprovalRequests(
  scope: {
    readonly orgId: string;
    readonly runId?: string;
    readonly threadId?: string;
  },
  now = new Date(),
): Promise<readonly ApprovalRequestRecord[]> {
  if (!scope.runId && !scope.threadId) return [];
  await db
    .update(gatewayApprovalRequests)
    .set({ status: "expired", resolvedAt: now })
    .where(
      and(
        eq(gatewayApprovalRequests.orgId, scope.orgId),
        eq(gatewayApprovalRequests.status, "pending"),
        lte(gatewayApprovalRequests.expiresAt, now),
        scope.runId
          ? eq(gatewayApprovalRequests.runId, scope.runId)
          : eq(gatewayApprovalRequests.threadId, scope.threadId ?? ""),
      ),
    );
  return db
    .select()
    .from(gatewayApprovalRequests)
    .where(
      and(
        eq(gatewayApprovalRequests.orgId, scope.orgId),
        eq(gatewayApprovalRequests.status, "pending"),
        scope.runId
          ? eq(gatewayApprovalRequests.runId, scope.runId)
          : eq(gatewayApprovalRequests.threadId, scope.threadId ?? ""),
      ),
    )
    .orderBy(desc(gatewayApprovalRequests.requestedAt))
    .limit(LIST_LIMIT);
}

/** The mint route's exact gate, applied to a stored request row: the target run
 *  must be ACTIVE and belong to the resolver. */
async function gateResolution(
  request: ApprovalRequestRecord,
  resolvedBy: string,
  deps: ApprovalResolutionDependencies,
  now: Date,
): Promise<ApprovalResolutionError | null> {
  const lapsed = await expireIfOverdue(request, now);
  if (lapsed.status === "expired" && request.status === "pending") return "request_expired";
  if (lapsed.status !== "pending") return "request_not_pending";
  const run = await deps.findRun(request.orgId, request.runId);
  if (!run) return "run_not_found";
  if (run.status !== "running") return "run_not_active";
  if (run.userId !== resolvedBy) return "run_user_mismatch";
  return null;
}

/**
 * Approve: mint the one-shot capability (same mint as POST /api/gateway/approvals)
 * and park it on the row for the agent's poll. Race-safe: the transition updates
 * only a still-pending row, so exactly one of any concurrent resolutions wins;
 * a loser's freshly minted capability is never referenced and simply expires in
 * the single-use ledger.
 */
export async function approveApprovalRequest(
  input: { readonly orgId: string; readonly requestId: string; readonly approvedBy: string },
  deps: ApprovalResolutionDependencies = defaultResolutionDependencies,
  now = new Date(),
): Promise<ApprovalResolutionResult> {
  const request = await getApprovalRequest(input.orgId, input.requestId);
  if (!request) return { ok: false, error: "request_not_found" };
  const gateError = await gateResolution(request, input.approvedBy, deps, now);
  if (gateError) return { ok: false, error: gateError };

  const minted = await deps.mint({
    orgId: request.orgId,
    userId: input.approvedBy,
    threadId: request.threadId,
    runId: request.runId,
    toolName: request.toolName,
    arguments: request.arguments,
  });
  const [approved] = await db
    .update(gatewayApprovalRequests)
    .set({
      status: "approved",
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
  await emitApprovalEvent(approved, "resolved");
  return { ok: true, request: approved };
}

/** Deny: same gate and single pending->denied transition, no capability. */
export async function denyApprovalRequest(
  input: { readonly orgId: string; readonly requestId: string; readonly deniedBy: string },
  deps: ApprovalResolutionDependencies = defaultResolutionDependencies,
  now = new Date(),
): Promise<ApprovalResolutionResult> {
  const request = await getApprovalRequest(input.orgId, input.requestId);
  if (!request) return { ok: false, error: "request_not_found" };
  const gateError = await gateResolution(request, input.deniedBy, deps, now);
  if (gateError) return { ok: false, error: gateError };

  const [denied] = await db
    .update(gatewayApprovalRequests)
    .set({ status: "denied", resolvedAt: now, resolvedBy: input.deniedBy })
    .where(
      and(
        eq(gatewayApprovalRequests.id, request.id),
        eq(gatewayApprovalRequests.status, "pending"),
      ),
    )
    .returning();
  if (!denied) return { ok: false, error: "request_not_pending" };
  await emitApprovalEvent(denied, "resolved");
  return { ok: true, request: denied };
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
