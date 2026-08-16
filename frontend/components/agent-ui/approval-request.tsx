"use client";

import type { ApprovalDecision, PendingApproval } from "@/components/chat/approval-state";
import { NativeApprovalCard } from "@/components/chat/native-approval-card";

export interface ApprovalRequestProps {
  readonly request: PendingApproval;
  readonly submitting?: boolean;
  readonly error?: string | null;
  readonly onRespond: (decision: ApprovalDecision) => void | Promise<void>;
}

/** Canonical approval surface shared with the session transcript. */
export function ApprovalRequest({
  request,
  submitting = false,
  error = null,
  onRespond,
}: ApprovalRequestProps) {
  return (
    <NativeApprovalCard
      request={request}
      submitting={submitting}
      error={error}
      onRespond={onRespond}
    />
  );
}

export type { ApprovalDecision, PendingApproval };
