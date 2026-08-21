import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";
import { fetchKnowledgeItems } from "./knowledge-api";
import { mockKnowledgeItems } from "./knowledge-data";
import { KnowledgeGallery } from "./knowledge-gallery";

export const metadata: Metadata = {
  title: "Knowledge",
  description: "Facts and conventions useAgent remembers across runs.",
};

export default async function KnowledgePage() {
  // SSR the real records when the backend is up. A failed fetch is surfaced as
  // `initialError` (a distinct, retryable error state) — NOT swallowed into the
  // empty seed, so an outage never reads as "no knowledge yet".
  let initialItems = mockKnowledgeItems;
  let initialLive = false;
  let initialError = false;
  try {
    initialItems = await fetchKnowledgeItems();
    initialLive = true;
  } catch {
    initialError = true;
  }

  return (
    <AppShell sidebar={<LibrarySidebar active="knowledge" />}>
      <KnowledgeGallery
        initialItems={initialItems}
        initialLive={initialLive}
        initialError={initialError}
      />
    </AppShell>
  );
}
