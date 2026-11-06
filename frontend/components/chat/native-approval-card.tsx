"use client";

// Provider-native approval container (unified in #351): the human side of the
// engine-native approval lane (OpenCode/Codex/Pi `approval.*` frames). It
// supplies the request context to the shared ApprovalCard and wires the four
// native decisions - Approve once, Always allow this session, Decline, Cancel
// turn - to the session's onRespond. These cards carry no status: the lane
// removes them on resolution (see approval-state.selectPendingApproval).

import { type ApprovalAction, ApprovalCard } from "@/components/ai/approval-card";
import type { ApprovalDecision, PendingApproval } from "./approval-state";

const ACTION_PHRASE: Record<PendingApproval["requestKind"], string> = {
  command: "run a command",
  "file-read": "read a file",
  "file-change": "change files",
  other: "use a tool",
};

export function NativeApprovalCard({
  request,
  submitting,
  error,
  onRespond,
}: {
  request: PendingApproval;
  submitting: boolean;
  error: string | null;
  onRespond: (decision: ApprovalDecision) => void | Promise<void>;
}) {
  const respond = (decision: ApprovalDecision) => () => void onRespond(decision);

  const actions: ApprovalAction[] = [
    { id: "cancel", label: "Cancel turn", tone: "ghost", onSelect: respond("cancel") },
    { id: "decline", label: "Decline", tone: "secondary", onSelect: respond("decline") },
    {
      id: "acceptForSession",
      label: "Always allow this session",
      tone: "secondary",
      onSelect: respond("acceptForSession"),
    },
    {
      id: "accept",
      label: submitting ? "Responding…" : "Approve once",
      tone: "primary",
      onSelect: respond("accept"),
    },
  ];

  return (
    <ApprovalCard
      testId="native-approval-card"
      ariaLabel={`Approval required to ${ACTION_PHRASE[request.requestKind]}`}
      title={`Approval required to ${ACTION_PHRASE[request.requestKind]}`}
      autoFocus
      busy={submitting}
      approveActionId="accept"
      rejectActionId="decline"
      actions={actions}
      error={error}
      body={
        request.detail ? (
          <pre className="text-caption-1-regular text-text-secondary max-h-32 overflow-auto whitespace-pre-wrap break-words">
            {request.detail}
          </pre>
        ) : undefined
      }
    />
  );
}
