import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { ChatSidebar } from "@/components/shell/chat-sidebar";
import { fetchArtifactSnapshot } from "@/lib/fetch-artifacts";
import { LiveArtifacts } from "../agent/artifacts/live-artifacts";

export const metadata: Metadata = {
  title: "Artifacts",
  description: "Files and outputs from your agent runs.",
};

export default async function ArtifactsPage() {
  const snapshot = await fetchArtifactSnapshot();

  return (
    <AppShell activeTab="chat" sidebar={<ChatSidebar active="artifacts" />}>
      <LiveArtifacts
        initialArtifacts={snapshot.artifacts}
        initialAvailable={snapshot.available}
      />
    </AppShell>
  );
}
