import type { Metadata } from "next";

import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import { fetchBrowse, fetchCaptures, fetchRecalls } from "./memory-api";
import type { BrowseResponse, CaptureRow, RecallLedgerRow } from "./memory-data";
import { MemoryHub } from "./memory-hub";

export const metadata: Metadata = {
  title: "Memory",
  description: "The team memory Skynet recalls, captures, and can correct.",
};

export default async function MemoryPage() {
  // SSR the organization browse + activity when the backend is up. A failed
  // fetch becomes `initialError` (a distinct, retryable state) - never swallowed
  // into an empty list, so an outage never reads as "no memory yet".
  let initialBrowse: BrowseResponse | null = null;
  let initialCaptures: CaptureRow[] = [];
  let initialRecalls: RecallLedgerRow[] = [];
  let initialError = false;
  try {
    [initialBrowse, initialCaptures, initialRecalls] = await Promise.all([
      fetchBrowse("org"),
      fetchCaptures().catch(() => []),
      fetchRecalls().catch(() => []),
    ]);
  } catch {
    initialError = true;
  }

  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="memory" />}>
      <MemoryHub
        initialBrowse={initialBrowse}
        initialCaptures={initialCaptures}
        initialRecalls={initialRecalls}
        initialError={initialError}
      />
    </AppShell>
  );
}
