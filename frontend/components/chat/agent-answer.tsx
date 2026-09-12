"use client";

// The agent's settled reply: the run's summary as Markdown, closed by the
// sources the chat engine retrieved for it (when its done step stored any).

import { type ChatCitation, ChatSourcesRow } from "@/components/chat/chat-citations";
import { MD_CLASS } from "@/components/chat/timeline-view";
import { Markdown } from "@/components/prompt-kit/markdown";

/** The agent's answer. No fake typewriter: real streaming is LiveNarration's
 * job (progressive markdown on actual deltas); once a run completes, the
 * summary renders as settled Markdown immediately - a plain-text re-typing
 * animation both lied about liveness and showed raw markdown runes. */
export function AgentAnswer({
  summary,
  citations = [],
}: {
  summary: string;
  stream?: boolean;
  /** What the reply drew on (chat engine): rendered as the Sources strip. */
  citations?: readonly ChatCitation[];
}) {
  return (
    <>
      <div className="animate-ai-fade-up" data-testid="agent-answer">
        <Markdown className={MD_CLASS}>{summary}</Markdown>
      </div>
      <ChatSourcesRow citations={citations} />
    </>
  );
}
