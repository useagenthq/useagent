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
  // SSR the real skills when the backend is up; fall back to the mock seed so
  // the page never renders empty while the backend is still coming online.
  let initialSkills = mockSkills;
  let initialLive = false;
  try {
    initialSkills = await fetchSkills();
    initialLive = true;
  } catch {
    // backend unreachable — keep the mock fallback
  }

  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="skills" />}>
      <SkillsView initialSkills={initialSkills} initialLive={initialLive} />
    </AppShell>
  );
}
