import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { ChatSidebar } from "@/components/shell/chat-sidebar";
import { ArtifactsGallery } from "./artifacts-gallery";

export const metadata: Metadata = {
  title: "Artifacts",
  description: "Everything Skynet has built for you, in one gallery.",
};

export default function ArtifactsPage() {
  return (
    <AppShell activeTab="chat" sidebar={<ChatSidebar active="artifacts" />}>
      <ArtifactsGallery />
    </AppShell>
  );
}
