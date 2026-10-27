"use client";

// #350: maps thread state into the activity the announcer wants. completed is a
// reply, a user cancel is a stop, a real failure stays null (the error banner
// handles it). Keyed on the thread root so switching threads resets it and we
// don't replay the new thread's last event.

import { isUserStopSummary } from "@/components/session-ui/thread-error-banner";
import type { GatewayApproval } from "@/lib/gateway-approvals";
import type { TurnOutcome } from "./agent-announcement";
import { AgentAnnouncer } from "./agent-announcer";
import type { PendingApproval } from "./approval-state";
import type { Turn } from "./conversation";
import type { PendingQuestion } from "./question-state";

export function ConversationAnnouncer({
  running,
  turns,
  pendingApproval,
  pendingQuestion,
  gatewayApprovals,
}: {
  readonly running: boolean;
  readonly turns: readonly Turn[];
  readonly pendingApproval: PendingApproval | null;
  readonly pendingQuestion: PendingQuestion | null;
  readonly gatewayApprovals: readonly GatewayApproval[] | undefined;
}) {
  const latestTurn = turns.at(-1);
  const outcome: TurnOutcome | null = running
    ? null
    : latestTurn?.status === "completed"
      ? "replied"
      : latestTurn?.status === "failed" && isUserStopSummary(latestTurn.summary)
        ? "stopped"
        : null;
  const pendingApprovalIds = (gatewayApprovals ?? [])
    .filter((approval) => approval.status === "pending")
    .map((approval) => approval.id);

  return (
    <AgentAnnouncer
      key={turns[0]?.run.id}
      running={running}
      outcome={outcome}
      approvalId={pendingApproval?.id ?? null}
      questionId={pendingQuestion?.id ?? null}
      pendingApprovalIds={pendingApprovalIds}
    />
  );
}
