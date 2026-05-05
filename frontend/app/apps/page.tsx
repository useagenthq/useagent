import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { ChatSidebar } from "@/components/shell/chat-sidebar";
import { AppsMarketplace } from "./apps-marketplace";

export const metadata: Metadata = {
  title: "Apps",
  description: "Connect the tools your team already uses.",
};

export default function AppsPage() {
  return (
    <AppShell activeTab="chat" sidebar={<ChatSidebar active="apps" />}>
      <AppsMarketplace />
    </AppShell>
  );
}
