"use client";

// #350: the one polite live region for the thread. Feeds each render's activity
// through agentAnnouncement and speaks whatever's new. Only ever holds a short
// sentence, never streamed text.

import { useEffect, useRef, useState } from "react";
import { type AgentActivity, agentAnnouncement, type TurnOutcome } from "./agent-announcement";

export function AgentAnnouncer({
  running,
  outcome,
  approvalId,
  questionId,
  pendingApprovalIds,
}: {
  readonly running: boolean;
  readonly outcome: TurnOutcome | null;
  readonly approvalId: string | null;
  readonly questionId: string | null;
  readonly pendingApprovalIds: readonly string[];
}) {
  // Join the ids so the effect dep is a string, not a new array every render.
  const pendingKey = pendingApprovalIds.join("\u0000");
  const prevActivityRef = useRef<AgentActivity | null>(null);
  const seqRef = useRef(0);
  const [announcement, setAnnouncement] = useState<{ text: string; seq: number } | null>(null);

  useEffect(() => {
    const activity: AgentActivity = {
      running,
      outcome,
      approvalId,
      questionId,
      pendingApprovalIds: pendingKey ? pendingKey.split("\u0000") : [],
    };
    const message = agentAnnouncement(prevActivityRef.current, activity);
    prevActivityRef.current = activity;
    if (message) {
      seqRef.current += 1;
      setAnnouncement({ text: message, seq: seqRef.current });
    }
  }, [running, outcome, approvalId, questionId, pendingKey]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {/* key changes per event, so two identical sentences in a row still get
          read out instead of being seen as "no change". */}
      {announcement && <span key={announcement.seq}>{announcement.text}</span>}
    </div>
  );
}
