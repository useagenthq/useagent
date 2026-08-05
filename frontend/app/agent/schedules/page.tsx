import type { Metadata } from "next";

import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import { SchedulesView } from "./schedules-view";

export const metadata: Metadata = {
  title: "Schedules",
  description: "Recurring and triggered runs Skynet starts on its own.",
};

export default function SchedulesPage() {
  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="schedules" />}>
      <SchedulesView />
    </AppShell>
  );
}
