import type { Metadata } from "next";
import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import { backendFetch } from "@/lib/backend-fetch";
import { extractRuns, type BackendRun } from "./derive";
import { LiveArtifacts } from "./live-artifacts";

export const metadata: Metadata = {
  title: "Live Artifacts",
  description: "Files and outputs streaming from agent runs.",
};

/** Server-side seed of the run list (cookies forwarded for org scoping). The
 * client then polls every 10s. Any failure yields an empty list → empty state. */
async function fetchRuns(): Promise<BackendRun[]> {
  try {
    const res = await backendFetch("/api/runs", { cache: "no-store" });
    if (!res.ok) return [];
    return extractRuns(await res.json()) ?? [];
  } catch {
    return [];
  }
}

export default async function LiveArtifactsPage() {
  const initialRuns = await fetchRuns();

  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="live-artifacts" />}>
      <LiveArtifacts initialRuns={initialRuns} />
    </AppShell>
  );
}
