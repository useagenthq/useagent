import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";
import { AppsMarketplace } from "./apps-marketplace";

export const metadata: Metadata = {
  title: "Apps",
  description: "Connect the tools your team already uses.",
};

export default function AppsPage() {
  return (
    <AppShell sidebar={<LibrarySidebar active="apps" />}>
      <AppsMarketplace />
    </AppShell>
  );
}
