import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";
import { LearningReview } from "./learning-review";
import { fetchDrafts, fetchProposals } from "./learnings-api";
import type { KnowledgeDraft, SkillProposal } from "./learnings-api";

export const metadata: Metadata = {
  title: "Learnings",
  description:
    "Review proposed knowledge drafts and skill revisions before they go live.",
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
    <AppShell sidebar={<LibrarySidebar active="learnings" />}>
      <LearningReview
        initialDrafts={initialDrafts}
        initialProposals={initialProposals}
        initialError={initialError}
      />
    </AppShell>
  );
}
