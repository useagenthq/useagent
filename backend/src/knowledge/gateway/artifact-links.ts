import type { ArtifactDescriptor } from "../../artifacts/repo";
import { env } from "../../env";

type ArtifactUrls = Pick<
  ArtifactDescriptor,
  "id" | "preview_url" | "download_url" | "workpiece"
>;

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
 * Workpieces preview through the rendered editor route. Their immutable source
 * bytes remain at preview_url, but Office content is intentionally served as an
 * attachment and therefore cannot be the browser-facing preview action.
 */
export function absoluteArtifactPreviewUrl(artifact: ArtifactUrls): string {
  const previewPath = artifact.workpiece
    ? `/agent/artifacts/${encodeURIComponent(artifact.id)}`
    : artifact.preview_url;
  return absoluteArtifactUrl(previewPath);
}

/**
 * Absolute-URL companions for tool structuredContent, kept beside the
 * unchanged relative artifact descriptor (the frontend consumes the
 * relative paths).
 */
export function absoluteArtifactUrlContent(artifact: ArtifactUrls): Record<string, string> {
  return {
    preview_url_absolute: absoluteArtifactPreviewUrl(artifact),
    download_url_absolute: absoluteArtifactUrl(artifact.download_url),
  };
}
