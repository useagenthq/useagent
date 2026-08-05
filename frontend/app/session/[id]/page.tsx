import { notFound } from "next/navigation";
import { backendFetch } from "@/lib/backend-fetch";
import { AppShell } from "@/components/shell/app-shell";
import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { SessionView } from "@/components/chat/session-view";
import { toThread } from "@/components/chat/types";

// Always render fresh: a session is a live run (cookies + streaming state).
export const dynamic = "force-dynamic";

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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
  if (!res || !res.ok) notFound();

  const thread = toThread(await res.json());
  if (thread.length === 0) notFound();

  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="active-runs" />}>
      <SessionView initialThread={thread} />
    </AppShell>
  );
}
