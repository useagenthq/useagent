import type { Metadata } from "next";

import { fetchArtifactSnapshot } from "@/lib/fetch-artifacts";
import { LiveArtifacts } from "../agent/artifacts/live-artifacts";

export const metadata: Metadata = {
  title: "Artifacts",
  description: "Files and outputs from your agent runs.",
};

export default async function ArtifactsPage() {
  const snapshot = await fetchArtifactSnapshot();

  return (
    <LiveArtifacts
      initialArtifacts={snapshot.artifacts}
      initialNextCursor={snapshot.nextCursor}
      initialAvailable={snapshot.available}
    />
  );
}
