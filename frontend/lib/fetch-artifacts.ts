import { extractArtifacts, type ArtifactDescriptor } from "@/components/artifacts/model";
import { backendFetch } from "@/lib/backend-fetch";

export interface ArtifactSnapshot {
  readonly artifacts: ArtifactDescriptor[];
  readonly available: boolean;
}

/** Server-side seed for both product shells. Availability is explicit so an
 * API outage never masquerades as a genuinely empty artifact collection. */
export async function fetchArtifactSnapshot(): Promise<ArtifactSnapshot> {
  try {
    const response = await backendFetch("/api/artifacts", { cache: "no-store" });
    if (!response.ok) return { artifacts: [], available: false };
    const artifacts = extractArtifacts(await response.json());
    return artifacts
      ? { artifacts, available: true }
      : { artifacts: [], available: false };
  } catch {
    return { artifacts: [], available: false };
  }
}
