// #350: picks what a screen reader should hear - a reply finishing, a user
// stop, or a new approval/question. Pure so we can unit-test it without a DOM.
// Running and real failures are left out on purpose: the running footer and the
// error banner already announce those.

/** completed = "replied", a user cancel = "stopped". A real failure is left to
 *  the error banner, so it isn't here. */
export type TurnOutcome = "replied" | "stopped";

export interface AgentActivity {
  readonly running: boolean;
  /** Newest settled turn's outcome, or null while running or on a real failure. */
  readonly outcome: TurnOutcome | null;
  /** Waiting native approval / question ids, null when none waits. */
  readonly approvalId: string | null;
  readonly questionId: string | null;
  /** Gateway (tool) approvals currently waiting. */
  readonly pendingApprovalIds: readonly string[];
}

const MESSAGES = {
  replied: "The agent replied.",
  stopped: "The agent stopped.",
  approval: "The agent needs your approval.",
  question: "The agent has a question.",
} as const;

/** A request id that wasn't there before - so we don't re-announce one that's
 *  just sitting there or getting resolved. */
function appeared(prevId: string | null, nextId: string | null): boolean {
  return nextId !== null && nextId !== prevId;
}

function gatewayAppeared(prev: readonly string[], next: readonly string[]): boolean {
  const before = new Set(prev);
  return next.some((id) => !before.has(id));
}

/**
 * What to announce going from `prev` to `next`, or null if nothing's new. First
 * snapshot (prev === null) stays quiet so opening an old thread doesn't replay
 * its last event. Something the user has to act on wins over a settled turn.
 */
export function agentAnnouncement(prev: AgentActivity | null, next: AgentActivity): string | null {
  if (!prev) return null;

  // Waiting on the user comes first - that's what's blocking them now.
  if (
    appeared(prev.approvalId, next.approvalId) ||
    gatewayAppeared(prev.pendingApprovalIds, next.pendingApprovalIds)
  ) {
    return MESSAGES.approval;
  }
  if (appeared(prev.questionId, next.questionId)) {
    return MESSAGES.question;
  }

  // Turn just settled.
  if (next.outcome !== null && next.outcome !== prev.outcome) {
    return MESSAGES[next.outcome];
  }

  return null;
}
