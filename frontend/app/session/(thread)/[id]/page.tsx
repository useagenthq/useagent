import { notFound } from "next/navigation";
import { botAssistantIdentity, botForThread } from "@/components/bots/identity";
import { loadBots } from "@/components/bots/load";
import { loadThreadView } from "@/components/chat/load-thread-view";
import { SessionView } from "@/components/chat/session-view";

// Always render fresh: a session is a live run (cookies + streaming state).
export const dynamic = "force-dynamic";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A thread a bot owns (delegated to it by an @mention) answers as that bot;
  // the roster is optional context, so its failure never blocks the thread.
  const [view, bots] = await Promise.all([loadThreadView(id), loadBots().catch(() => null)]);
  if (!view) notFound();
  const bot = botForThread(bots, id);
  // The persistent shell lives in the (thread) layout above this segment.
  return (
    <SessionView
      initialThread={view.thread}
      initialOutline={view.outline}
      initialRelationshipHint={view.relationshipHint}
      assistantIdentity={bot ? botAssistantIdentity(bot) : undefined}
    />
  );
}
