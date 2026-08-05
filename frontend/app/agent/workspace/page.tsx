import type { Metadata } from "next";
import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import { backendFetch } from "@/lib/backend-fetch";
import { extractRuns, type WorkspaceRun } from "./workspace-data";
import { WorkspaceView } from "./workspace-view";

export const metadata: Metadata = {
  title: "Workspace",
  description: "Mission control for your agent fleet.",
};

/** SSR snapshot of the fleet so the status banner is in the first paint; the
 * client view refreshes it every 15s. Backend is the source of truth. */
async function loadRuns(): Promise<WorkspaceRun[]> {
  try {
    const res = await backendFetch("/api/runs", { cache: "no-store" });
    if (!res.ok) return [];
    return extractRuns(await res.json());
  } catch {
    return [];
  }
}

export default async function WorkspacePage() {
  const initialRuns = await loadRuns();

  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="workspace" />}>
      <WorkspaceView initialRuns={initialRuns} />
    </AppShell>
  );
}
