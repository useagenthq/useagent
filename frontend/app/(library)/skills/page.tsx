import type { Metadata } from "next";
import { fetchSkillsLibrary } from "./skills-api";
import { mockSkills } from "./skills-data";
import { SkillsView } from "./skills-view";

export const metadata: Metadata = {
  title: "Skills - UseAgent",
  description: "Reusable skills UseAgent follows for repeatable work.",
  openGraph: {
    title: "Skills - UseAgent",
    description: "Reusable skills UseAgent follows for repeatable work.",
    images: [{ url: "/og/15-skills.png", width: 1600, height: 900, alt: "UseAgent Skills" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Skills - UseAgent",
    description: "Reusable skills UseAgent follows for repeatable work.",
    images: ["/og/15-skills.png"],
  },
};

export default async function SkillsPage() {
  // SSR the real skills when the backend is up. A failed fetch is surfaced as
  // `initialError` (a distinct, retryable error state) - NOT swallowed into the
  // empty seed, so an outage never reads as "no skills yet". Scoped to plain
  // skills; playbooks live on their own page over the same substrate. The
  // library view is section-free so a big imported catalog stays a small page.
  let initialSkills = mockSkills;
  let initialLive = false;
  let initialError = false;
  try {
    initialSkills = await fetchSkillsLibrary("skill");
    initialLive = true;
  } catch {
    initialError = true;
  }

  return (
    <SkillsView
        initialSkills={initialSkills}
        initialLive={initialLive}
        initialError={initialError}
      />
  );
}
