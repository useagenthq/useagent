import type { Metadata } from "next";

import { fetchArtifactSnapshot } from "@/lib/fetch-artifacts";
import { LiveArtifacts } from "../agent/artifacts/live-artifacts";

export const metadata: Metadata = {
  title: "Artifacts - UseAgent",
  description: "Files and outputs from your agent runs.",
  openGraph: {
    title: "Artifacts - UseAgent",
    description: "Files and outputs from your agent runs.",
    images: [{ url: "/og/10-library.png", width: 1600, height: 900, alt: "UseAgent Artifacts" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Artifacts - UseAgent",
    description: "Files and outputs from your agent runs.",
    images: ["/og/10-library.png"],
  },
};

export default async function ArtifactsPage() {
  const snapshot = await fetchArtifactSnapshot();

  return (
    <LiveArtifacts initialArtifacts={snapshot.artifacts} initialAvailable={snapshot.available} />
  );
}
