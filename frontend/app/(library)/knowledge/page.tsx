import type { Metadata } from "next";
import { fetchKnowledge } from "./knowledge-api";
import { mockKnowledgeItems } from "./knowledge-data";
import { KnowledgeGallery } from "./knowledge-gallery";

export const metadata: Metadata = {
  title: "Knowledge",
  description: "Facts and conventions UseAgent remembers across runs.",
};

export default async function KnowledgePage() {
  // SSR the real records when the backend is up. A failed fetch is surfaced as
  // `initialError` (a distinct, retryable error state) — NOT swallowed into the
  // empty seed, so an outage never reads as "no knowledge yet".
  let initialItems = mockKnowledgeItems;
  let initialSearchNote: string | null = null;
  let initialNextCursor: string | null = null;
  let initialLive = false;
  let initialError = false;
  try {
    const index = await fetchKnowledge();
    initialItems = index.items;
    initialSearchNote = index.searchNote;
    initialNextCursor = index.nextCursor;
    initialLive = true;
  } catch {
    initialError = true;
  }

  return (
    <KnowledgeGallery
        initialItems={initialItems}
        initialSearchNote={initialSearchNote}
        initialNextCursor={initialNextCursor}
        initialLive={initialLive}
        initialError={initialError}
      />
  );
}
