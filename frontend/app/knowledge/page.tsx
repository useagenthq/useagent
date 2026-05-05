import type { Metadata } from "next";

import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import { fetchKnowledgeItems } from "./knowledge-api";
import { mockKnowledgeItems } from "./knowledge-data";
import { KnowledgeGallery } from "./knowledge-gallery";

export const metadata: Metadata = {
  title: "Knowledge",
  description: "Facts and conventions Skynet remembers across runs.",
};

export default async function KnowledgePage() {
  // SSR the real records when the backend is up; fall back to the mock seed so
  // the page never renders empty while the backend is still coming online.
  let initialItems = mockKnowledgeItems;
  let initialLive = false;
  try {
    initialItems = await fetchKnowledgeItems();
    initialLive = true;
  } catch {
    // backend unreachable — keep the mock fallback
  }

  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="knowledge" />}>
      <KnowledgeGallery initialItems={initialItems} initialLive={initialLive} />
    </AppShell>
  );
}
