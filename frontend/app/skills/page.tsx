import type { Metadata } from "next";

import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import { fetchSkills } from "./skills-api";
import { mockSkills } from "./skills-data";
import { SkillsView } from "./skills-view";

export const metadata: Metadata = {
  title: "Skills",
  description: "Reusable playbooks Skynet follows for repeatable work.",
};

export default async function SkillsPage() {
  // SSR the real skills when the backend is up. A failed fetch is surfaced as
  // `initialError` (a distinct, retryable error state) — NOT swallowed into the
  // empty seed, so an outage never reads as "no skills yet".
  let initialSkills = mockSkills;
  let initialLive = false;
  let initialError = false;
  try {
    initialSkills = await fetchSkills();
    initialLive = true;
  } catch {
    initialError = true;
  }

  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="skills" />}>
      <SkillsView
        initialSkills={initialSkills}
        initialLive={initialLive}
        initialError={initialError}
      />
    </AppShell>
  );
}
