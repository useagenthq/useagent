import { describe, expect, test } from "bun:test";
import {
  artifactViewFor,
  extractArtifacts,
  formatArtifactSize,
} from "./model";

const descriptor = {
  id: "a1",
  run_id: "r1",
  thread_id: "t1",
  name: "report.pdf",
  source_path: "/root/work/report.pdf",
  content_type: "application/pdf",
  size_bytes: 1536,
  sha256: "a".repeat(64),
  created_at: "2026-08-10T00:00:00.000Z",
  preview_url: "/api/artifacts/a1/content",
  download_url: "/api/artifacts/a1/content?download=1",
  preview_pdf_url: null,
  workpiece: null,
};

describe("artifact wire model", () => {
  test("accepts only complete durable descriptors", () => {
    expect(extractArtifacts({ artifacts: [descriptor] })).toEqual([descriptor]);
    expect(extractArtifacts({ artifacts: [{ ...descriptor, sha256: null }] })).toBeNull();
    expect(extractArtifacts({ runs: [] })).toBeNull();
  });

  test("uses real MIME/name metadata for filters and labels", () => {
    expect(artifactViewFor(descriptor)).toMatchObject({ category: "docs", extension: "PDF" });
    expect(artifactViewFor({
      ...descriptor,
      name: "demo.webm",
      content_type: "video/webm",
    }).category).toBe("media");
    expect(artifactViewFor({
      ...descriptor,
      name: "archive.zip",
      content_type: "application/zip",
    }).category).toBe("files");
  });

  test("derives preview and runtime actions from the shared artifact contract", () => {
    expect(artifactViewFor({
      ...descriptor,
      name: "unsafe.svg",
      content_type: "image/svg+xml",
    })).toMatchObject({
      category: "media",
      extension: "SVG",
      preview: { inline: false, renderer: null },
      actions: ["download"],
    });
    expect(artifactViewFor({
      ...descriptor,
      name: "photo.png",
      content_type: "image/png",
    })).toMatchObject({
      category: "media",
      extension: "PNG",
      preview: { inline: true, renderer: "image" },
    });
  });

  test("formats exact byte counts without fabricated sizes", () => {
    expect(formatArtifactSize(42)).toBe("42 B");
    expect(formatArtifactSize(1536)).toBe("1.5 KB");
    expect(formatArtifactSize(12 * 1024 * 1024)).toBe("12 MB");
  });
});
