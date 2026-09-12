import { RiPlugLine } from "@remixicon/react";
import type { Metadata } from "next";
import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";
import { PluginsPanel } from "./plugins-panel";

export const metadata: Metadata = {
  title: "Plugins",
  description: "Connections and credentials actually enabled for your agents.",
};

export default function AgentPluginsPage() {
  return (
    <AppShell sidebar={<LibrarySidebar active="plugins" />}>
      <div className="mx-auto w-full max-w-[880px] px-6 py-8 sm:px-10 sm:py-10">
        <div className="flex items-center gap-2.5">
          <RiPlugLine aria-hidden className="size-5 text-foreground-icon-primary" />
          <h1 className="text-title-2-medium text-text-primary">Plugins</h1>
        </div>
        <p className="mt-1.5 text-body-2-regular text-text-secondary">
          Connections and credentials enabled for your agents
        </p>
        <div className="mt-6">
          <PluginsPanel />
        </div>
      </div>
    </AppShell>
  );
}
