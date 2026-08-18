import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";

/**
 * The persistent shell for thread views. Living ABOVE the `[id]` segment, this
 * layout survives session-to-session navigation, so switching threads swaps
 * only the conversation area (the segment's loading skeleton renders inside
 * it) instead of unmounting the sidebar and flashing a full-viewport loader.
 */
export default function ThreadLayout({ children }: { children: ReactNode }) {
  return <AppShell sidebar={<ThreadSidebar />}>{children}</AppShell>;
}
