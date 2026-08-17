import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";
import { ComponentLab } from "./component-lab";

export const metadata: Metadata = {
  title: "Component lab - skynet-a",
  description: "Skynet agent UI primitives and the complete vendored component parts bin.",
};

export default function LabPage() {
  return (
    <AppShell sidebar={<ThreadSidebar />}>
      <ComponentLab />
    </AppShell>
  );
}
