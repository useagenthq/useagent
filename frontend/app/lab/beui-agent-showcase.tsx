"use client";

import {
  RiBookOpenLine,
  RiChat1Line,
  RiChat3Line,
  RiChatHistoryLine,
  RiCodeSSlashLine,
  RiCursorLine,
  RiFlashlightLine,
  RiGitBranchLine,
  RiImageLine,
  RiLayoutRightLine,
  RiLightbulbLine,
  RiListCheck2,
  RiLoader4Line,
  RiPulseLine,
  RiRefreshLine,
  RiRobot2Line,
  RiShieldCheckLine,
  RiSparkling2Line,
  RiTerminalBoxLine,
} from "@remixicon/react";
import type { ComponentType } from "react";
import { type ChipTone, IconChip } from "@/components/board-ui/icon-chip";

// Already-ported reference trio.
import CitationsDemo from "@/components/agent-ui/citations";
import TodoListDemo from "@/components/agent-ui/todo-list";
import ToolApprovalDemo from "@/components/agent-ui/tool-approval";

// Newly ported agent-ui demos.
import AgentActivityDemo from "@/components/agent-ui/agent-activity";
import AgentLoaderDemo from "@/components/agent-ui/agent-loader";
import AgentProgressDemo from "@/components/agent-ui/agent-progress";
import AISidebarDemo from "@/components/agent-ui/ai-sidebar";
import ChatAppDemo from "@/components/agent-ui/chat-app";
import CodeBlockDemo from "@/components/agent-ui/code-block";
import FileDiffDemo from "@/components/agent-ui/file-diff";
import ImageGenerationDemo from "@/components/agent-ui/image-generation";
import MessageDemo from "@/components/agent-ui/message";
import MessageBubbleDemo from "@/components/agent-ui/message-bubble";
import MessageScrollerDemo from "@/components/agent-ui/message-scroller";
import PromptInputDemo from "@/components/agent-ui/prompt-input";
import ReasoningTextDemo from "@/components/agent-ui/reasoning-text";
import RichApprovalCardDemo from "@/components/agent-ui/rich-approval-card";
import StreamingResponseDemo from "@/components/agent-ui/streaming-response";
import ThinkingShimmerDemo from "@/components/agent-ui/thinking-shimmer";
import ToolResultDemo from "@/components/agent-ui/tool-result";

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

type Entry = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly Demo: ComponentType;
  readonly icon: IconComponent;
  readonly tone: ChipTone;
};

const ENTRIES: readonly Entry[] = [
  { id: "todo-list", title: "Todo list", description: "Plan checklist with per-item status and progress.", Demo: TodoListDemo, icon: RiListCheck2, tone: "green" },
  { id: "tool-approval", title: "Tool approval", description: "Human-in-the-loop permission card for a tool call.", Demo: ToolApprovalDemo, icon: RiShieldCheckLine, tone: "orange" },
  { id: "citations", title: "Citations", description: "Inline source markers over a collapsible reference list.", Demo: CitationsDemo, icon: RiBookOpenLine, tone: "blue" },
  { id: "rich-approval-card", title: "Rich approval card", description: "Detailed approval surface with options and custom responses.", Demo: RichApprovalCardDemo, icon: RiShieldCheckLine, tone: "purple" },
  { id: "tool-result", title: "Tool result", description: "Expandable tool output with status, duration, and preview.", Demo: ToolResultDemo, icon: RiTerminalBoxLine, tone: "blue" },
  { id: "message-bubble", title: "Message bubble", description: "Chat bubble for user and assistant turns.", Demo: MessageBubbleDemo, icon: RiChat3Line, tone: "blue" },
  { id: "message", title: "Message", description: "Full message block with avatar, header, and rich parts.", Demo: MessageDemo, icon: RiChat1Line, tone: "purple" },
  { id: "message-scroller", title: "Message scroller", description: "Auto-scrolling transcript that pins to the latest message.", Demo: MessageScrollerDemo, icon: RiChatHistoryLine, tone: "neutral" },
  { id: "streaming-response", title: "Streaming response", description: "Token-by-token assistant reply with a live caret.", Demo: StreamingResponseDemo, icon: RiFlashlightLine, tone: "orange" },
  { id: "reasoning-text", title: "Reasoning text", description: "Collapsible chain-of-thought reasoning block.", Demo: ReasoningTextDemo, icon: RiLightbulbLine, tone: "purple" },
  { id: "thinking-shimmer", title: "Thinking shimmer", description: "Shimmering placeholder while the agent is thinking.", Demo: ThinkingShimmerDemo, icon: RiSparkling2Line, tone: "blue" },
  { id: "agent-loader", title: "Agent loader", description: "Animated loader states for an agent starting or working.", Demo: AgentLoaderDemo, icon: RiLoader4Line, tone: "orange" },
  { id: "agent-progress", title: "Agent progress", description: "Verb-driven progress line narrating the current step.", Demo: AgentProgressDemo, icon: RiRefreshLine, tone: "green" },
  { id: "agent-activity", title: "Agent activity", description: "Timeline of agent steps, tool calls, and phases.", Demo: AgentActivityDemo, icon: RiPulseLine, tone: "blue" },
  { id: "code-block", title: "Code block", description: "Code with a copy control and language label.", Demo: CodeBlockDemo, icon: RiCodeSSlashLine, tone: "purple" },
  { id: "file-diff", title: "File diff", description: "Diff view of added and removed lines.", Demo: FileDiffDemo, icon: RiGitBranchLine, tone: "green" },
  { id: "prompt-input", title: "Prompt input", description: "Composer with model picker, attachments, and submit.", Demo: PromptInputDemo, icon: RiCursorLine, tone: "blue" },
  { id: "ai-sidebar", title: "AI sidebar", description: "Assistant side panel with thread history and actions.", Demo: AISidebarDemo, icon: RiLayoutRightLine, tone: "neutral" },
  { id: "chat-app", title: "Chat app", description: "End-to-end chat surface composing the messaging primitives.", Demo: ChatAppDemo, icon: RiRobot2Line, tone: "purple" },
  { id: "image-generation", title: "Image generation", description: "Image result grid with generation status.", Demo: ImageGenerationDemo, icon: RiImageLine, tone: "orange" },
];

function ShowcaseCard({ entry }: { readonly entry: Entry }) {
  const { id, title, description, Demo, icon, tone } = entry;
  return (
    <div
      id={`beui-${id}`}
      data-agent-ui-component={id}
      className="flex flex-col gap-4 rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-5 shadow-regular-sm"
    >
      <div className="flex items-start gap-3">
        <IconChip icon={icon} tone={tone} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-title-h6 text-text-strong-950">{title}</h3>
          <p className="text-paragraph-sm text-text-sub-600">{description}</p>
        </div>
      </div>
      <div className="min-w-0">
        <Demo />
      </div>
    </div>
  );
}

/** The full beUI agent component set (components/agent-ui), rendered inline in the lab as a
 * single full-width column so every piece is legible and extendable without leaving the page. */
export function BeuiAgentShowcase() {
  return (
    <section className="flex flex-col gap-4 border-t border-stroke-soft-200 py-8">
      <p className="text-mono-label text-text-soft-400">
        beUI agent components (components/agent-ui) - the full agent set on our tokens
      </p>
      <div className="flex flex-col gap-5">
        {ENTRIES.map((entry) => (
          <ShowcaseCard key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}
