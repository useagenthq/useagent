import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";
import { fetchRuns, type Run } from "./runs-data";
import { RunsList } from "./runs-list";

export const metadata: Metadata = {
  title: "Active runs",
  description: "Live agent runs from the Skynet orchestrator.",
};

// Always render fresh — the runs list is live data.
export const dynamic = "force-dynamic";

export default async function AgentRunsPage() {
  let initialRuns: Run[] = [];
  let initialError = false;

  try {
    initialRuns = await fetchRuns();
  } catch {
    initialError = true;
  }

  return (
    <AppShell sidebar={<ThreadSidebar />}>
      <RunsList initialRuns={initialRuns} initialError={initialError} />
    </AppShell>
  );
}
