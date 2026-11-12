import { extractArtifacts, type ArtifactDescriptor } from "@/components/artifacts/model";
import { backendFetch } from "@/lib/backend-fetch";

export interface ArtifactPage {
  readonly artifacts: ArtifactDescriptor[];
  /** Cursor for the page after this one; null on the last page, or from a backend that does not page. */
  readonly nextCursor: string | null;
}

export interface ArtifactSnapshot extends ArtifactPage {
  readonly available: boolean;
}

/** The request for one page of GET /api/artifacts: the newest page, or the one after `cursor`. */
export function artifactPagePath(cursor: string | null = null): string {
  return cursor ? `/api/artifacts?cursor=${encodeURIComponent(cursor)}` : "/api/artifacts";
}

/** Read a GET /api/artifacts answer; null when it holds no valid artifact list. */
export function readArtifactPage(value: unknown): ArtifactPage | null {
  const artifacts = extractArtifacts(value);
  if (!artifacts) return null;
  const cursor = (value as { next_cursor?: unknown }).next_cursor;
  return { artifacts, nextCursor: typeof cursor === "string" && cursor.length > 0 ? cursor : null };
}

/**
 * Put a refreshed newest page in front of what is already loaded. Artifacts
 * are only ever added, so one that left the newest page is older than all of
 * it: the loaded rows it no longer holds follow in their order, and none drops
 * out of view.
 */
export function mergeNewestPage(
  newest: readonly ArtifactDescriptor[],
  loaded: readonly ArtifactDescriptor[],
): ArtifactDescriptor[] {
  const ids = new Set(newest.map((artifact) => artifact.id));
  return [...newest, ...loaded.filter((artifact) => !ids.has(artifact.id))];
}

/** Add an older page after what is loaded, without repeating an artifact already shown. */
export function appendOlderPage(
  loaded: readonly ArtifactDescriptor[],
  older: readonly ArtifactDescriptor[],
): ArtifactDescriptor[] {
  const ids = new Set(loaded.map((artifact) => artifact.id));
  return [...loaded, ...older.filter((artifact) => !ids.has(artifact.id))];
}

/** Server-side seed for both product shells. Availability is explicit so an
 * API outage never masquerades as a genuinely empty artifact collection. */
export async function fetchArtifactSnapshot(): Promise<ArtifactSnapshot> {
  try {
    const response = await backendFetch(artifactPagePath(), { cache: "no-store" });
    if (!response.ok) return { artifacts: [], nextCursor: null, available: false };
    const page = readArtifactPage(await response.json());
    return page
      ? { ...page, available: true }
      : { artifacts: [], nextCursor: null, available: false };
  } catch {
    return { artifacts: [], nextCursor: null, available: false };
  }
}
