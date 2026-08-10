import type { Metadata } from "next";
import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import { fetchArtifactSnapshot } from "@/lib/fetch-artifacts";
import { LiveArtifacts } from "./live-artifacts";

export const metadata: Metadata = {
  title: "Live Artifacts",
  description: "Files and outputs streaming from agent runs.",
};

export default async function LiveArtifactsPage() {
  const snapshot = await fetchArtifactSnapshot();

  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="live-artifacts" />}>
      <LiveArtifacts
        initialArtifacts={snapshot.artifacts}
        initialAvailable={snapshot.available}
      />
    </AppShell>
  );
}
