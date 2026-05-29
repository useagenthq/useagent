import { AiChatShell } from "@/components/application/ai-chat/ai-chat-shell";
import { withOg } from "@/lib/og";

export const metadata = withOg({
  title: "AI Chat Template — React + Tailwind Coding Agent UI",
  description:
    "BoardUI Pro AI chat template: agent sidebar with repositories and recent chats, message thread with composer and status bar, and a live changes/code panel.",
  kind: "template",
  pro: true,
});

/**
 * Figma source: Board UI → "ai_chat" (node 4030:5897, 1440×900).
 */
export default function AiChatTemplate() {
  return <AiChatShell />;
}
