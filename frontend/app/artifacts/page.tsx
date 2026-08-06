import type { Metadata } from "next";

import { AppShell } from "@/components/shell/app-shell";
import { ChatSidebar } from "@/components/shell/chat-sidebar";
import { backendFetch } from "@/lib/backend-fetch";
import { extractRuns, type BackendRun } from "../agent/artifacts/derive";
import { LiveArtifacts } from "../agent/artifacts/live-artifacts";

export const metadata: Metadata = {
  title: "Artifacts",
  description: "Files and outputs from your agent runs.",
};

/** Chat-shell view over the SAME real artifact derivation as /agent/artifacts.
 * The previous hardcoded gallery (fake "AI Landing Page 1h ago" cards) violated
 * the no-fabricated-data rule and was replaced by this real surface. */
async function fetchRuns(): Promise<BackendRun[]> {
  try {
    const res = await backendFetch("/api/runs", { cache: "no-store" });
    if (!res.ok) return [];
    return extractRuns(await res.json()) ?? [];
  } catch {
    return [];
  }
}

export default async function ArtifactsPage() {
  const initialRuns = await fetchRuns();

  return (
    <AppShell activeTab="chat" sidebar={<ChatSidebar active="artifacts" />}>
      <LiveArtifacts initialRuns={initialRuns} />
    </AppShell>
  );
}
