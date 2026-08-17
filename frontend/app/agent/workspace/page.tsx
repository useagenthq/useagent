import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";
import { backendFetch } from "@/lib/backend-fetch";
import { extractRuns, type WorkspaceRun } from "./workspace-data";
import { WorkspaceView } from "./workspace-view";

export const metadata: Metadata = {
  title: "Workspace",
  description: "Mission control for your agent fleet.",
};

/** SSR snapshot of the fleet so the status banner is in the first paint; the
 * client view refreshes it every 15s. Backend is the source of truth. A failed
 * fetch is reported as `error` (a distinct, retryable state) — NOT an empty
 * fleet, so an outage never renders as a calm "0 runs, all clear". */
async function loadRuns(): Promise<{ runs: WorkspaceRun[]; error: boolean }> {
  try {
    const res = await backendFetch("/api/runs", { cache: "no-store" });
    if (!res.ok) return { runs: [], error: true };
    return { runs: extractRuns(await res.json()), error: false };
  } catch {
    return { runs: [], error: true };
  }
}

export default async function WorkspacePage() {
  const { runs: initialRuns, error: initialError } = await loadRuns();

  return (
    <AppShell sidebar={<ThreadSidebar active="projects" />}>
      <WorkspaceView initialRuns={initialRuns} initialError={initialError} />
    </AppShell>
  );
}
