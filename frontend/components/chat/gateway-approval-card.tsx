"use client";

// Gateway approval container (#77): the human side of the approval lane. Wraps
// (never forks) the vendored components/ai/approval-card.tsx with the run
// context it needs - tool name, one-level argument summary, status - and wires
// Approve/Deny to lib/gateway-approvals.ts with an optimistic pending ->
// resolved transition that rolls back on API failure.

import { RiShieldCheckLine } from "@remixicon/react";
import { useState } from "react";
import { ApprovalCard } from "@/components/ai/approval-card";
import { Chip } from "@/components/base/badges/chip";
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
  { readonly color: "yellow" | "lime" | "rose" | "neutral"; readonly label: string }
> = {
  pending: { color: "yellow", label: "Pending" },
  approved: { color: "lime", label: "Approved" },
  denied: { color: "rose", label: "Denied" },
  expired: { color: "neutral", label: "Expired" },
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
      <div className="border-border-button-default bg-background-secondary-default space-y-3 rounded-2xl border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="bg-yellow-500/10 text-yellow-600 flex size-7 shrink-0 items-center justify-center rounded-full">
              <RiShieldCheckLine className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-body-2-medium text-text-primary">
                Tool approval:{" "}
                <span className="font-mono text-body-2-medium">{approval.toolName}</span>
              </p>
              {requestedAt && (
                <p className="text-caption-1-regular text-text-tertiary">
                  Requested {requestedAt}
                </p>
              )}
            </div>
          </div>
          <Chip variant="caption" color={badge.color}>
            {badge.label}
          </Chip>
        </div>

        {entries.length > 0 && (
          <dl className="border-border-button-default bg-background-primary-default space-y-1 overflow-hidden rounded-xl border px-3 py-2 font-mono text-caption-1-regular">
            {entries.map((entry) => (
              <div key={entry.key} className="flex min-w-0 gap-2">
                <dt className="text-text-secondary shrink-0">{entry.key}:</dt>
                <dd className="text-text-primary truncate">{entry.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {status !== "pending" && (
          <p className="text-caption-1-regular text-text-secondary">
            {resolution.phase === "submitting"
              ? decisionInFlightLine(resolution.decision)
              : resolvedLine(status, approval)}
          </p>
        )}
        {/* Action errors only matter while the card is still actionable - once
            the record resolves (e.g. the 409 refetch landed) the resolved line
            is the whole truth. */}
        {status === "pending" && error && (
          <p className="text-caption-1-regular text-red-500">{error}</p>
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
