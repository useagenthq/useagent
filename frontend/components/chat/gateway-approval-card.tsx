"use client";

// Gateway approval container (#77, unified in #351): the human side of the
// approval lane. Supplies the run context (tool name, one-level argument
// summary, status) to the shared ApprovalCard and wires Approve / Deny to
// lib/gateway-approvals.ts with an optimistic pending -> resolved transition
// that rolls back on API failure. The denial reason is captured only after the
// user chooses to deny, then carried to the agent when the decision continues
// the thread.

import { useEffect, useRef, useState } from "react";
import { type ApprovalAction, ApprovalCard } from "@/components/ai/approval-card";
import { Input } from "@/components/base/input/input";
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

function decisionInFlightLine(decision: GatewayApprovalDecision): string {
  return decision === "approve" ? "Approving…" : "Denying…";
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
  // The reason is only entered after the user chooses to deny.
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLInputElement>(null);

  // Opening the deny flow unmounts the Deny button that had focus; move focus
  // to the reason box so the shortcuts keep working and the user can type.
  useEffect(() => {
    if (denying) reasonRef.current?.focus();
  }, [denying]);
  const status = effectiveStatus(approval.status, resolution);
  const error = resolution.phase === "idle" ? resolution.error : null;
  const entries = summarizeApprovalArguments(approval.arguments);
  const badge = STATUS_BADGE[status];
  const requestedAt = formatTimestamp(approval.requestedAt);
  const submitting = resolution.phase === "submitting";

  async function submit(decision: GatewayApprovalDecision) {
    if (submitting) return;
    setResolution(beginResolution(resolution, decision));
    try {
      const settledStatus = await resolveGatewayApproval(
        approval.id,
        decision,
        decision === "deny" ? reason.trim() || null : null,
      );
      setResolution(resolutionSucceeded(settledStatus));
      onResolved?.();
    } catch (cause) {
      const httpStatus = cause instanceof GatewayApprovalRequestError ? cause.httpStatus : null;
      setResolution(resolutionFailed(httpStatus));
      // Lost the race: someone else already resolved it; refetch shows the truth.
      if (httpStatus === 409) onResolved?.();
    }
  }

  const pending = status === "pending";
  const actions: ApprovalAction[] = !pending
    ? []
    : denying
      ? [
          {
            id: "cancel-deny",
            label: "Keep reviewing",
            tone: "ghost",
            onSelect: () => setDenying(false),
          },
          {
            id: "confirm-deny",
            label: "Deny",
            tone: "primary",
            onSelect: () => void submit("deny"),
          },
        ]
      : [
          {
            id: "deny",
            label: "Deny",
            tone: "secondary",
            onSelect: () => setDenying(true),
          },
          {
            id: "approve",
            label: "Approve",
            tone: "primary",
            onSelect: () => void submit("approve"),
          },
        ];

  return (
    <ApprovalCard
      testId="gateway-approval-card"
      ariaLabel={`Approval for ${approval.toolName}`}
      title={
        <>
          Tool approval: <span className="font-mono text-body-2-medium">{approval.toolName}</span>
        </>
      }
      subtitle={requestedAt ? `Requested ${requestedAt}` : undefined}
      chip={badge}
      autoFocus={pending}
      busy={submitting}
      approveActionId={denying ? "confirm-deny" : "approve"}
      rejectActionId={denying ? "cancel-deny" : "deny"}
      actions={actions}
      body={
        entries.length > 0 ? (
          <dl className="border-border-button-default bg-background-primary-default space-y-1 overflow-hidden rounded-xl border px-3 py-2 font-mono text-caption-1-regular">
            {entries.map((entry) => (
              <div key={entry.key} className="flex min-w-0 gap-2">
                <dt className="text-text-secondary shrink-0">{entry.key}:</dt>
                <dd className="text-text-primary truncate">{entry.value}</dd>
              </div>
            ))}
          </dl>
        ) : undefined
      }
      note={
        submitting
          ? decisionInFlightLine(resolution.decision)
          : pending
            ? undefined
            : resolvedLine(status, approval)
      }
      error={pending ? error : null}
      reason={
        pending && denying ? (
          <Input
            ref={reasonRef}
            size="small"
            aria-label="Reason for denying"
            placeholder="Reason, if you want to add one (optional)"
            value={reason}
            onChange={setReason}
            isDisabled={submitting}
          />
        ) : undefined
      }
    />
  );
}
