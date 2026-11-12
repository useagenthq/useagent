import type { Metadata } from "next";
import { fetchRuns, type Run } from "./runs-data";
import { RunsList } from "./runs-list";

export const metadata: Metadata = {
  title: "All threads",
  description: "Live agent runs from the UseAgent orchestrator.",
};

// Always render fresh — the runs list is live data.
export const dynamic = "force-dynamic";

export default async function AgentRunsPage() {
  let initialRuns: Run[] = [];
  let initialNextCursor: string | null = null;
  let initialError = false;

  try {
    const page = await fetchRuns();
    initialRuns = page.runs;
    initialNextCursor = page.nextCursor;
  } catch {
    initialError = true;
  }

  return (
    <RunsList
      initialRuns={initialRuns}
      initialNextCursor={initialNextCursor}
      initialError={initialError}
    />
  );
}
