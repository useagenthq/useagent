import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";

export default function BotsLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell sidebar={<ThreadSidebar active="bots" />} collapseSidebarAtTablet>
      {children}
    </AppShell>
  );
}
