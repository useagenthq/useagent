import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";
import { fetchSkillsLibrary } from "./skills-api";
import { mockSkills } from "./skills-data";
import { SkillsView } from "./skills-view";

export const metadata: Metadata = {
  title: "Skills",
  description: "Reusable skills useAgent follows for repeatable work.",
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
    <AppShell sidebar={<LibrarySidebar active="skills" />}>
      <SkillsView
        initialSkills={initialSkills}
        initialLive={initialLive}
        initialError={initialError}
      />
    </AppShell>
  );
}
