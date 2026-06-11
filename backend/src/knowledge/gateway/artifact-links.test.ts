import { describe, expect, test } from "bun:test";
import type { ArtifactWorkpieceKind } from "@useagent/artifact-workspace";
import type { ArtifactDescriptor } from "../../artifacts/repo";
import { env } from "../../env";
import { absoluteArtifactUrlContent } from "./artifact-links";

function workpieceArtifact(kind: ArtifactWorkpieceKind): ArtifactDescriptor {
  const extension = kind === "presentation" ? "pptx" : "xlsx";
  return {
    id: `artifact-${kind}`,
    run_id: "run-1",
    thread_id: "thread-1",
    name: `result.${extension}`,
    source_path: `/root/work/result.${extension}`,
    content_type: "application/octet-stream",
    size_bytes: 1234,
    sha256: "abc",
    created_at: "2026-08-30T00:00:00.000Z",
    preview_url: `/api/artifacts/artifact-${kind}/content`,
    download_url: `/api/artifacts/artifact-${kind}/content?download=1`,
    preview_pdf_url: null,
    workpiece: {
      kind,
      source_version: "abc",
      state_revision: 0,
      state_url: `/api/artifacts/artifact-${kind}/workpiece`,
      export_url: `/api/artifacts/artifact-${kind}/workpiece/export`,
      exports: [],
      actions: ["preview", "download", "edit"],
    },
  };
}

describe("absolute artifact links", () => {
  test.each(["presentation", "spreadsheet"] as const)(
    "routes a %s preview action to the rendered workpiece and keeps download on source bytes",
    (kind) => {
      const artifact = workpieceArtifact(kind);

      expect(absoluteArtifactUrlContent(artifact)).toEqual({
        preview_url_absolute: `${env.FRONTEND_ORIGIN}/agent/artifacts/${artifact.id}`,
        download_url_absolute: `${env.FRONTEND_ORIGIN}${artifact.download_url}`,
      });
    },
  );
});
