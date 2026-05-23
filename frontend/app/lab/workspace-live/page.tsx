"use client";

import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";
import { WorkspaceLiveHarness } from "./live-reload-harness";

export default function WorkspaceLivePage() {
  return (
    <AppShell sidebar={<ThreadSidebar />}>
      <WorkspaceLiveHarness />
    </AppShell>
  );
}
