"use client";

// Lab playground for the announcer (#350): fire each event and see what it
// speaks. Turn on VoiceOver or NVDA to actually hear it. Real failures are
// silent here on purpose - the error banner handles those.

import { useRef, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { type AgentActivity, agentAnnouncement } from "@/components/chat/agent-announcement";
import { AgentAnnouncer } from "@/components/chat/agent-announcer";

const IDLE_ACTIVITY: AgentActivity = {
  running: false,
  outcome: null,
  approvalId: null,
  questionId: null,
  pendingApprovalIds: [],
};

export function AnnouncerShowcase() {
  const [activity, setActivity] = useState<AgentActivity>({ ...IDLE_ACTIVITY, running: true });
  const [spoken, setSpoken] = useState<readonly string[]>([]);
  const nextApproval = useRef(0);

  const apply = (next: AgentActivity) => {
    const message = agentAnnouncement(activity, next);
    if (message) setSpoken((log) => [message, ...log].slice(0, 6));
    setActivity(next);
  };

  return (
    <div className="flex flex-col gap-3">
      <AgentAnnouncer
        running={activity.running}
        outcome={activity.outcome}
        approvalId={activity.approvalId}
        questionId={activity.questionId}
        pendingApprovalIds={activity.pendingApprovalIds}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="small"
          onClick={() => apply({ ...IDLE_ACTIVITY, outcome: "replied" })}
        >
          Reply finished
        </Button>
        <Button
          variant="secondary"
          size="small"
          onClick={() => apply({ ...IDLE_ACTIVITY, outcome: "stopped" })}
        >
          Stopped by user
        </Button>
        <Button
          variant="secondary"
          size="small"
          onClick={() => {
            nextApproval.current += 1;
            apply({ ...activity, running: true, approvalId: `ap${nextApproval.current}` });
          }}
        >
          New approval
        </Button>
        <Button
          variant="secondary"
          size="small"
          onClick={() => apply({ ...activity, running: true, questionId: "q1" })}
        >
          New question
        </Button>
        <Button
          variant="ghost"
          size="small"
          onClick={() => apply({ ...IDLE_ACTIVITY, running: true })}
        >
          Clear (back to running)
        </Button>
      </div>
      <div className="border-border-button-default bg-background-primary-default rounded-xl border px-3 py-2">
        <p className="text-caption-1-regular text-text-tertiary">
          Announced (newest first) - a real failure is intentionally silent here, the error banner
          owns it:
        </p>
        {spoken.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {spoken.map((line, index) => (
              <li
                // Newest is index 0; good enough key for a short demo log.
                key={`${spoken.length - index}-${line}`}
                className="text-caption-1-regular text-text-primary"
              >
                {line}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-caption-1-regular text-text-secondary mt-1">Nothing announced yet.</p>
        )}
      </div>
    </div>
  );
}
