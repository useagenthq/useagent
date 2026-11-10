import type { Metadata } from "next";
import { fetchRunsPage, type RunsPage } from "./runs-data";
import { RunsList } from "./runs-list";

export const metadata: Metadata = {
  title: "All threads",
  description: "Live agent runs from the UseAgent orchestrator.",
};

// Always render fresh — the runs list is live data.
export const dynamic = "force-dynamic";

export default async function AgentRunsPage() {
  let initialPage: RunsPage = { runs: [], nextCursor: null };
  let initialError = false;

  try {
    initialPage = await fetchRunsPage();
  } catch {
    initialError = true;
  }

  return (
    <RunsList
      initialRuns={initialPage.runs}
      initialNextCursor={initialPage.nextCursor}
      initialError={initialError}
    />
  );
}
