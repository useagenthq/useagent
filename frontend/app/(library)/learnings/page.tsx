import type { Metadata } from "next";

import { LearningReview } from "./learning-review";
import { fetchDrafts, fetchProposals } from "./learnings-api";
import type { KnowledgeDraft, SkillProposal } from "./learnings-api";

export const metadata: Metadata = {
  title: "Learnings - UseAgent",
  description:
    "Review proposed knowledge drafts and skill revisions before they go live.",
  openGraph: {
    title: "Learnings - UseAgent",
    description:
      "Review proposed knowledge drafts and skill revisions before they go live.",
    images: [{ url: "/og/17-learnings.png", width: 1600, height: 900, alt: "UseAgent Learnings" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Learnings - UseAgent",
    description:
      "Review proposed knowledge drafts and skill revisions before they go live.",
    images: ["/og/17-learnings.png"],
  },
};

export default async function LearningsPage() {
  // SSR both review queues when the backend is up. A failed fetch becomes
  // `initialError` (a distinct, retryable state) - never an empty list, so an
  // outage never reads as "nothing to review".
  let initialDrafts: KnowledgeDraft[] = [];
  let initialProposals: SkillProposal[] = [];
  let initialError = false;
  try {
    [initialDrafts, initialProposals] = await Promise.all([
      fetchDrafts(),
      fetchProposals(),
    ]);
  } catch {
    initialError = true;
  }

  return (
    <LearningReview
        initialDrafts={initialDrafts}
        initialProposals={initialProposals}
        initialError={initialError}
      />
  );
}
