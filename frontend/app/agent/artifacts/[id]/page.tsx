import { decodeArtifactResult } from "@skynet/agent-client";
import { notFound } from "next/navigation";
import { AgentSidebar } from "@/components/shell/agent-sidebar";
import { AppShell } from "@/components/shell/app-shell";
import { backendFetch } from "@/lib/backend-fetch";
import { ArtifactEditor } from "./artifact-editor";

export default async function ArtifactEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const response = await backendFetch(`/api/artifacts/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (!response.ok) notFound();
  const result = decodeArtifactResult(await response.json());
  if (!result?.artifact.workpiece) notFound();

  return (
    <AppShell activeTab="agent" sidebar={<AgentSidebar active="live-artifacts" />}>
      <ArtifactEditor artifact={result.artifact} />
    </AppShell>
  );
}
