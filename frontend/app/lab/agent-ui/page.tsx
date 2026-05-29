"use client";

import type { ComponentType } from "react";
import { cn } from "@/utils/cn";

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

type GalleryEntry = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly Demo: ComponentType;
};

const ENTRIES: readonly GalleryEntry[] = [
  {
    id: "message-bubble",
    title: "Message bubble",
    description: "Chat bubble for user and assistant turns with role-aware styling.",
    Demo: MessageBubbleDemo,
  },
  {
    id: "message",
    title: "Message",
    description: "Full message block with avatar, header, and rich content parts.",
    Demo: MessageDemo,
  },
  {
    id: "message-scroller",
    title: "Message scroller",
    description: "Auto-scrolling transcript that pins to the latest message.",
    Demo: MessageScrollerDemo,
  },
  {
    id: "streaming-response",
    title: "Streaming response",
    description: "Token-by-token assistant reply with a live typing caret.",
    Demo: StreamingResponseDemo,
  },
  {
    id: "reasoning-text",
    title: "Reasoning text",
    description: "Collapsible chain-of-thought block for model reasoning traces.",
    Demo: ReasoningTextDemo,
  },
  {
    id: "thinking-shimmer",
    title: "Thinking shimmer",
    description: "Shimmering placeholder shown while the agent is thinking.",
    Demo: ThinkingShimmerDemo,
  },
  {
    id: "agent-loader",
    title: "Agent loader",
    description: "Animated loader states for an agent starting up or working.",
    Demo: AgentLoaderDemo,
  },
  {
    id: "agent-progress",
    title: "Agent progress",
    description: "Verb-driven progress line that narrates the current step.",
    Demo: AgentProgressDemo,
  },
  {
    id: "agent-activity",
    title: "Agent activity",
    description: "Timeline of agent steps, tool calls, and phase transitions.",
    Demo: AgentActivityDemo,
  },
  {
    id: "code-block",
    title: "Code block",
    description: "Syntax-highlighted code with a copy control and language label.",
    Demo: CodeBlockDemo,
  },
  {
    id: "file-diff",
    title: "File diff",
    description: "Unified/side-by-side diff view of added and removed lines.",
    Demo: FileDiffDemo,
  },
  {
    id: "tool-result",
    title: "Tool result",
    description: "Expandable tool output with status, duration, and preview.",
    Demo: ToolResultDemo,
  },
  {
    id: "tool-approval",
    title: "Tool approval",
    description: "Inline approve/deny prompt gating a tool invocation.",
    Demo: ToolApprovalDemo,
  },
  {
    id: "rich-approval-card",
    title: "Rich approval card",
    description: "Detailed approval surface with options and custom responses.",
    Demo: RichApprovalCardDemo,
  },
  {
    id: "citations",
    title: "Citations",
    description: "Source citations rendered inline and as a reference footer.",
    Demo: CitationsDemo,
  },
  {
    id: "todo-list",
    title: "Todo list",
    description: "Canonical plan checklist with per-item status and progress.",
    Demo: TodoListDemo,
  },
  {
    id: "prompt-input",
    title: "Prompt input",
    description: "Composer with model picker, attachments, and submit controls.",
    Demo: PromptInputDemo,
  },
  {
    id: "ai-sidebar",
    title: "AI sidebar",
    description: "Assistant side panel with thread history and quick actions.",
    Demo: AISidebarDemo,
  },
  {
    id: "chat-app",
    title: "Chat app",
    description: "End-to-end chat surface composing the messaging primitives.",
    Demo: ChatAppDemo,
  },
  {
    id: "image-generation",
    title: "Image generation",
    description: "Image result grid with generation status and prompt metadata.",
    Demo: ImageGenerationDemo,
  },
];

function GalleryCard({ entry }: { readonly entry: GalleryEntry }) {
  const { id, title, description, Demo } = entry;
  return (
    <section
      id={id}
      data-agent-ui-gallery-component={id}
      className={cn(
        "flex flex-col gap-4 rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-5 shadow-regular-sm",
      )}
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-title-h6 text-text-strong-950">{title}</h2>
        <p className="text-paragraph-sm text-text-sub-600">{description}</p>
      </div>
      <div className="min-w-0">
        <Demo />
      </div>
    </section>
  );
}

export default function AgentUiGalleryPage() {
  return (
    <main className={cn("min-h-full bg-bg-weak-50")}>
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-10">
        <header className="flex flex-col gap-2">
          <p className="text-mono-label text-text-soft-400">beUI.dev × useAgent</p>
          <h1 className="text-title-h3 text-text-strong-950">beUI agent components</h1>
          <p className="max-w-2xl text-paragraph-md text-text-sub-600">
            The full beUI agent component set, each rendered from its self-contained demo. Every card
            is a live component on our tokens - toggle the theme to confirm both light and dark.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {ENTRIES.map((entry) => (
            <GalleryCard key={entry.id} entry={entry} />
          ))}
        </div>
      </div>
    </main>
  );
}
