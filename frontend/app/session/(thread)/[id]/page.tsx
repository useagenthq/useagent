import { notFound } from "next/navigation";
import { SessionView } from "@/components/chat/session-view";
import { toThread } from "@/components/chat/types";
import { backendFetch } from "@/lib/backend-fetch";

// Always render fresh: a session is a live run (cookies + streaming state).
export const dynamic = "force-dynamic";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // `?thread=1` returns the whole conversation (oldest→newest). `toThread`
  // tolerates the pre-thread single-run shape so this works before/after the
  // backend thread endpoint ships.
  let res: Response | null = null;
  try {
    res = await backendFetch(`/api/runs/${id}?thread=1`);
  } catch {
    res = null;
  }
  if (!res?.ok) notFound();

  const thread = toThread(await res.json());
  if (thread.length === 0) notFound();

  // The persistent shell lives in the (thread) layout above this segment.
  return <SessionView initialThread={thread} />;
}
