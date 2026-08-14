import { describe, expect, test } from "bun:test";
import {
  categoryForArtifact,
  extensionLabel,
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
  workpiece: null,
};

describe("artifact wire model", () => {
  test("accepts only complete durable descriptors", () => {
    expect(extractArtifacts({ artifacts: [descriptor] })).toEqual([descriptor]);
    expect(extractArtifacts({ artifacts: [{ ...descriptor, sha256: null }] })).toBeNull();
    expect(extractArtifacts({ runs: [] })).toBeNull();
  });

  test("uses real MIME/name metadata for filters and labels", () => {
    expect(categoryForArtifact(descriptor)).toBe("docs");
    expect(categoryForArtifact({ name: "demo.webm", content_type: "video/webm" })).toBe("media");
    expect(categoryForArtifact({ name: "archive.zip", content_type: "application/zip" })).toBe("files");
    expect(extensionLabel("report.final.pdf")).toBe("PDF");
  });

  test("formats exact byte counts without fabricated sizes", () => {
    expect(formatArtifactSize(42)).toBe("42 B");
    expect(formatArtifactSize(1536)).toBe("1.5 KB");
    expect(formatArtifactSize(12 * 1024 * 1024)).toBe("12 MB");
  });
});
