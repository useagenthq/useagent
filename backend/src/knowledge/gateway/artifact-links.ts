import type { ArtifactDescriptor } from "../../artifacts/repo";
import { env } from "../../env";

type ArtifactUrls = Pick<ArtifactDescriptor, "preview_url" | "download_url">;

/**
 * Absolute browser URL for a backend-relative artifact path such as
 * /api/artifacts/:id/content. Tool results must hand models the full
 * FRONTEND_ORIGIN URL, otherwise they hallucinate a host around the
 * relative path (a live run printed an app.example.com artifact URL).
 */
export function absoluteArtifactUrl(relativePath: string): string {
  return new URL(relativePath, env.FRONTEND_ORIGIN).toString();
}

/**
 * Absolute-URL companions for tool structuredContent, kept beside the
 * unchanged relative artifact descriptor (the frontend consumes the
 * relative paths).
 */
export function absoluteArtifactUrlContent(artifact: ArtifactUrls): Record<string, string> {
  return {
    preview_url_absolute: absoluteArtifactUrl(artifact.preview_url),
    download_url_absolute: absoluteArtifactUrl(artifact.download_url),
  };
}
