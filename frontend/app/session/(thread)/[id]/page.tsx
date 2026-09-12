import { notFound } from "next/navigation";
import { loadThreadView } from "@/components/chat/load-thread-view";
import { SessionView } from "@/components/chat/session-view";

// Always render fresh: a session is a live run (cookies + streaming state).
export const dynamic = "force-dynamic";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const view = await loadThreadView(id);
  if (!view) notFound();
  // The persistent shell lives in the (thread) layout above this segment.
  return (
    <SessionView
      initialThread={view.thread}
      initialOutline={view.outline}
      initialRelationshipHint={view.relationshipHint}
    />
  );
}
