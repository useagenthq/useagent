import type { ReactNode } from "react";
import { loadBots } from "@/components/bots/load";
import { AppShell } from "@/components/shell/app-shell";
import { BotsPanel } from "@/components/shell/bots-panel";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";

export default async function BotsLayout({ children }: { children: ReactNode }) {
  let initialBots = null;
  let initialError = false;
  try {
    initialBots = await loadBots();
    initialError = initialBots === null;
  } catch {
    initialError = true;
  }

  return (
    <AppShell
      sidebar={<ThreadSidebar active="bots" />}
      panel={<BotsPanel initialBots={initialBots} initialError={initialError} />}
      collapseSidebarAtTablet
    >
      {children}
    </AppShell>
  );
}
