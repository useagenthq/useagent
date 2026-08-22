import { AiChatShell } from "@/components/application/ai-chat/ai-chat-shell";
import { withOg } from "@/lib/og";

export const metadata = withOg({
  title: "AI Image Generation Template — React + Tailwind Agent UI",
  description:
    "BoardUI Pro AI image generation template: prompt thread with a live generation frame, feedback actions, and a gallery panel of past generations.",
  kind: "template",
  pro: true,
});

/**
 * The AI chat shell opened on its image-generation thread: the message
 * thread renders the generation frame and feedback row, and the right-hand
 * panel becomes the generations gallery instead of the code view.
 */
export default function AiImageGenerationTemplate() {
  return <AiChatShell defaultScenario="image-generation" />;
}
