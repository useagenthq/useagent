import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";
import { WorkspaceSample } from "./workspace-sample";

export const metadata: Metadata = {
  title: "Workspace pane - useAgent",
  description:
    "The session Workspace side pane rendered through the real workpiece editor surfaces, for visual review.",
};

export default function WorkspaceSamplePage() {
  return (
    <AppShell sidebar={<ThreadSidebar />}>
      <WorkspaceSample />
    </AppShell>
  );
}
