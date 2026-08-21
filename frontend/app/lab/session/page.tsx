import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";
import { SessionSample } from "./session-sample";

export const metadata: Metadata = {
  title: "Session sample - useAgent",
  description:
    "One synthetic session rendered through the real chat timeline and session chrome - every canonical event type in one place, for visual review.",
};

export default function SessionSamplePage() {
  return (
    <AppShell sidebar={<ThreadSidebar />}>
      <SessionSample />
    </AppShell>
  );
}
