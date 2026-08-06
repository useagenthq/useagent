import type { Metadata } from "next";
import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import { PluginsPanel } from "./plugins-panel";

export const metadata: Metadata = {
  title: "Plugins",
  description: "Connections and skills actually enabled for your agents.",
};

export default function AgentPluginsPage() {
  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="plugins" />}>
      <div className="flex justify-center p-6 lg:p-12">
        <div className="w-full max-w-sm">
          <h1 className="sr-only">Plugins</h1>
          <PluginsPanel />
        </div>
      </div>
    </AppShell>
  );
}
