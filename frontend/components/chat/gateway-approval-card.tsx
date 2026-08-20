"use client";

// Gateway approval container (#77): the human side of the approval lane. Wraps
// (never forks) the vendored components/ai/approval-card.tsx with the run
// context it needs - tool name, one-level argument summary, status - and wires
// Approve/Deny to lib/gateway-approvals.ts with an optimistic pending ->
// resolved transition that rolls back on API failure.

import { RiShieldCheckLine } from "@remixicon/react";
import { useState } from "react";
import { ApprovalCard } from "@/components/ai/approval-card";
import * as Badge from "@/components/ui/badge";
import {
  type GatewayApproval,
  type GatewayApprovalDecision,
  GatewayApprovalRequestError,
  type GatewayApprovalStatus,
  resolveGatewayApproval,
} from "@/lib/gateway-approvals";
import {
  type ApprovalResolution,
  beginResolution,
  effectiveStatus,
  idleResolution,
  resolutionFailed,
  resolutionSucceeded,
  summarizeApprovalArguments,
} from "./gateway-approval-state";

const STATUS_BADGE: Record<
  GatewayApprovalStatus,
  { readonly color: "orange" | "green" | "red" | "gray"; readonly label: string }
> = {
  pending: { color: "orange", label: "Pending" },
  approved: { color: "green", label: "Approved" },
  denied: { color: "red", label: "Denied" },
  expired: { color: "gray", label: "Expired" },
};

function formatTimestamp(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function resolvedLine(status: GatewayApprovalStatus, approval: GatewayApproval): string {
  if (status === "expired") return "Expired without a decision";
  const verb = status === "approved" ? "Approved" : "Denied";
  const by = approval.resolvedBy ? ` by ${approval.resolvedBy}` : "";
  const at = approval.resolvedAt ? formatTimestamp(approval.resolvedAt) : null;
  return at ? `${verb}${by} · ${at}` : `${verb}${by}`;
}

export function GatewayApprovalCard({
  approval,
  onResolved,
}: {
  approval: GatewayApproval;
  /** Nudge the fetch lane after this client resolves (or loses a race on) it. */
  onResolved?: () => void;
}) {
  const [resolution, setResolution] = useState<ApprovalResolution>(idleResolution);
  const status = effectiveStatus(approval.status, resolution);
  const error = resolution.phase === "idle" ? resolution.error : null;
  const entries = summarizeApprovalArguments(approval.arguments);
  const badge = STATUS_BADGE[status];
  const requestedAt = formatTimestamp(approval.requestedAt);

  async function submit(decision: GatewayApprovalDecision) {
    if (resolution.phase === "submitting") return;
    setResolution(beginResolution(resolution, decision));
    try {
      const settledStatus = await resolveGatewayApproval(approval.id, decision);
      setResolution(resolutionSucceeded(settledStatus));
      onResolved?.();
    } catch (cause) {
      const httpStatus =
        cause instanceof GatewayApprovalRequestError ? cause.httpStatus : null;
      setResolution(resolutionFailed(httpStatus));
      // Lost the race: someone else already resolved it; refetch shows the truth.
      if (httpStatus === 409) onResolved?.();
    }
  }

  return (
    <section data-testid="gateway-approval-card" className="space-y-2">
      <div className="border-stroke-soft-200 bg-bg-weak-50 space-y-3 rounded-2xl border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="bg-warning-alpha-10 text-warning-base flex size-7 shrink-0 items-center justify-center rounded-full">
              <RiShieldCheckLine className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-label-sm text-text-strong-950">
                Tool approval:{" "}
                <span className="font-mono text-label-sm">{approval.toolName}</span>
              </p>
              {requestedAt && (
                <p className="text-paragraph-xs text-text-soft-400">
                  Requested {requestedAt}
                </p>
              )}
            </div>
          </div>
          <Badge.Root variant="light" color={badge.color}>
            {badge.label}
          </Badge.Root>
        </div>

        {entries.length > 0 && (
          <dl className="border-stroke-soft-200 bg-bg-white-0 space-y-1 overflow-hidden rounded-xl border px-3 py-2 font-mono text-paragraph-xs">
            {entries.map((entry) => (
              <div key={entry.key} className="flex min-w-0 gap-2">
                <dt className="text-text-sub-600 shrink-0">{entry.key}:</dt>
                <dd className="text-text-strong-950 truncate">{entry.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {status !== "pending" && (
          <p className="text-paragraph-xs text-text-sub-600">
            {resolution.phase === "submitting"
              ? decisionInFlightLine(resolution.decision)
              : resolvedLine(status, approval)}
          </p>
        )}
        {/* Action errors only matter while the card is still actionable - once
            the record resolves (e.g. the 409 refetch landed) the resolved line
            is the whole truth. */}
        {status === "pending" && error && (
          <p className="text-paragraph-xs text-error-base">{error}</p>
        )}
      </div>

      {status === "pending" && (
        <ApprovalCard
          question={`Allow ${approval.toolName}?`}
          options={[
            {
              label: `Run ${approval.toolName}`,
              detail: "One-time approval for this tool call",
            },
          ]}
          onApprove={() => void submit("approve")}
          onDeny={() => void submit("deny")}
        />
      )}
    </section>
  );
}

function decisionInFlightLine(decision: GatewayApprovalDecision): string {
  return decision === "approve" ? "Approving…" : "Denying…";
}
