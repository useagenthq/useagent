import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";
import { AutomationsView } from "../schedules/automations-view";

export const metadata: Metadata = {
  title: "Automations",
  description: "Recurring and triggered runs Skynet starts on its own.",
};

export default function AutomationsPage() {
  return (
    <AppShell sidebar={<LibrarySidebar active="automations" />}>
      <AutomationsView />
    </AppShell>
  );
}
