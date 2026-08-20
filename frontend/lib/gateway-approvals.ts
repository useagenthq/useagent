// Gateway approval lane (#77) - the ONE contract boundary for the human
// Approve/Deny flow. Everything that touches this wire shape lives here so any
// backend drift reconciles in this single file.
//
// Contract (reconciled against the landed backend, approval-routes.ts):
//   GET  /api/gateway/approvals/requests?runId=<id>
//     -> { requests: [{ id, run_id, thread_id, tool_name, arguments (object),
//          status: "pending"|"approved"|"denied"|"expired", requested_at,
//          expires_at, resolved_at, resolved_by }] }  (PENDING rows only; a
//          resolved row leaves the list - the POST response carries its state)
//   POST /api/gateway/approvals/requests/:id/approve -> { id, status }  (409 race, 403 non-member)
//   POST /api/gateway/approvals/requests/:id/deny    -> { id, status }

import { asRecord } from "@/components/chat/types";
import { backendFetch } from "@/lib/backend-fetch";

export type GatewayApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type GatewayApprovalDecision = "approve" | "deny";

export interface GatewayApproval {
  readonly id: string;
  readonly runId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly status: GatewayApprovalStatus;
  readonly requestedAt: string;
  readonly resolvedAt: string | null;
  /** Not promised by the contract; parsed when present so "approved by" can be
   *  honest if the backend carries the resolver's name. */
  readonly resolvedBy: string | null;
}

const STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "approved",
  "denied",
  "expired",
] satisfies GatewayApprovalStatus[]);

/** Defensive parse of one wire approval. Unknown statuses drop the record
 *  (never render a state we cannot act on); a malformed `arguments` degrades
 *  to an empty object rather than dropping the card. */
export function parseGatewayApproval(raw: unknown): GatewayApproval | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = record.id;
  const runId = record.run_id;
  const toolName = record.tool_name;
  const status = record.status;
  const requestedAt = record.requested_at;
  if (typeof id !== "string" || !id) return null;
  if (typeof runId !== "string" || !runId) return null;
  if (typeof toolName !== "string" || !toolName) return null;
  if (typeof status !== "string" || !STATUSES.has(status)) return null;
  if (typeof requestedAt !== "string" || !requestedAt) return null;
  return {
    id,
    runId,
    toolName,
    arguments: asRecord(record.arguments) ?? {},
    status: status as GatewayApprovalStatus,
    requestedAt,
    resolvedAt: typeof record.resolved_at === "string" ? record.resolved_at : null,
    resolvedBy: typeof record.resolved_by === "string" ? record.resolved_by : null,
  };
}

/** A gateway request that failed with an HTTP status the UI maps to copy
 *  (403 -> membership, 409 -> lost race). `httpStatus` null means network. */
export class GatewayApprovalRequestError extends Error {
  constructor(
    readonly httpStatus: number | null,
    message: string,
  ) {
    super(message);
    this.name = "GatewayApprovalRequestError";
  }
}

export async function fetchGatewayApprovals(runId: string): Promise<GatewayApproval[]> {
  const response = await backendFetch(
    `/api/gateway/approvals/requests?runId=${encodeURIComponent(runId)}`,
  );
  if (!response.ok) {
    throw new GatewayApprovalRequestError(response.status, `backend ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as { requests?: unknown } | null;
  const list = Array.isArray(body?.requests) ? body.requests : [];
  return list.flatMap((item) => {
    const approval = parseGatewayApproval(item);
    return approval ? [approval] : [];
  });
}

export async function resolveGatewayApproval(
  id: string,
  decision: GatewayApprovalDecision,
): Promise<GatewayApprovalStatus> {
  const response = await backendFetch(
    `/api/gateway/approvals/requests/${encodeURIComponent(id)}/${decision}`,
    { method: "POST" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      message?: unknown;
    };
    const message =
      typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : `backend ${response.status}`;
    throw new GatewayApprovalRequestError(response.status, message);
  }
  const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
  return typeof body?.status === "string" && STATUSES.has(body.status)
    ? (body.status as GatewayApprovalStatus)
    : decision === "approve"
      ? "approved"
      : "denied";
}
