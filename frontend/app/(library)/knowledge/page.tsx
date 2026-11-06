import type { Metadata } from "next";
import { fetchKnowledge } from "./knowledge-api";
import { mockKnowledgeItems } from "./knowledge-data";
import { KnowledgeGallery } from "./knowledge-gallery";

export const metadata: Metadata = {
  title: "Knowledge - UseAgent",
  description: "Facts and conventions UseAgent remembers across runs.",
  openGraph: {
    title: "Knowledge - UseAgent",
    description: "Facts and conventions UseAgent remembers across runs.",
    images: [{ url: "/og/11-knowledge.png", width: 1600, height: 900, alt: "UseAgent Knowledge" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Knowledge - UseAgent",
    description: "Facts and conventions UseAgent remembers across runs.",
    images: ["/og/11-knowledge.png"],
  },
};

export default async function KnowledgePage() {
  // SSR the real records when the backend is up. A failed fetch is surfaced as
  // `initialError` (a distinct, retryable error state) — NOT swallowed into the
  // empty seed, so an outage never reads as "no knowledge yet".
  let initialItems = mockKnowledgeItems;
  let initialSearchNote: string | null = null;
  let initialLive = false;
  let initialError = false;
  try {
    const index = await fetchKnowledge();
    initialItems = index.items;
    initialSearchNote = index.searchNote;
    initialLive = true;
  } catch {
    initialError = true;
  }

  return (
    <KnowledgeGallery
        initialItems={initialItems}
        initialSearchNote={initialSearchNote}
        initialLive={initialLive}
        initialError={initialError}
      />
  );
}
