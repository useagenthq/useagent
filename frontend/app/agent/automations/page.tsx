import type { Metadata } from "next";

import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import { AutomationsView } from "../schedules/automations-view";

export const metadata: Metadata = {
  title: "Automations",
  description: "Recurring and triggered runs Skynet starts on its own.",
};

export default function AutomationsPage() {
  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="automations" />}>
      <AutomationsView />
    </AppShell>
  );
}
