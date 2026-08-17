import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";
import { DesignGallery } from "./design-gallery";

export const metadata: Metadata = {
  title: "Design - skynet-a",
  description: "Your design canvas - frames Skynet is shaping with you.",
};

export default function DesignPage() {
  return (
    <AppShell sidebar={<ThreadSidebar />}>
      <DesignGallery />
    </AppShell>
  );
}
