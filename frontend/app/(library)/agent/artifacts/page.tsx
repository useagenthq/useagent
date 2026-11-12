import type { Metadata } from "next";
import { fetchArtifactSnapshot } from "@/lib/fetch-artifacts";
import { LiveArtifacts } from "./live-artifacts";

export const metadata: Metadata = {
  title: "Live Artifacts",
  description: "Files and outputs streaming from agent runs.",
};

export default async function LiveArtifactsPage({
  searchParams,
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const snapshot = await fetchArtifactSnapshot();
  const params = await searchParams;
  const rawRunId = params?.run_id;
  const initialRunId = typeof rawRunId === "string" ? rawRunId : undefined;

  return (
    <LiveArtifacts
        initialArtifacts={snapshot.artifacts}
        initialNextCursor={snapshot.nextCursor}
        initialAvailable={snapshot.available}
        initialRunId={initialRunId}
      />
  );
}
