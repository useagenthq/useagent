"use client";

// #350: maps thread state into the activity the announcer wants. completed is a
// reply, a user cancel is a stop, a real failure stays null (the error banner
// handles it). Keyed on the thread root so switching threads resets it and we
// don't replay the new thread's last event. SessionView renders it beside its
// panes, never inside the conversation section: that section is hidden while the
// side panel is expanded and inert under the phone panel, and a live region there
// goes unheard.

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
  /** Undefined until the thread's first fetch answers. */
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
  // Not loaded yet is no list at all: what the first fetch finds is the baseline.
  const pendingApprovalIds =
    gatewayApprovals
      ?.filter((approval) => approval.status === "pending")
      .map((approval) => approval.id) ?? null;

  return (
    <AgentAnnouncer
      key={turns[0]?.run.id}
      running={running}
      outcome={outcome}
      turnId={latestTurn?.run.id ?? null}
      approvalId={pendingApproval?.id ?? null}
      questionId={pendingQuestion?.id ?? null}
      pendingApprovalIds={pendingApprovalIds}
    />
  );
}
