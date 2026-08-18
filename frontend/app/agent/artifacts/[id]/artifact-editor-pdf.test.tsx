import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrgChange } from "@/lib/org-changes";
import {
  isByteAuthoritativePdf,
  shouldReloadOnArtifactSignal,
} from "./artifact-editor-state";
import { PdfBinaryCodeView, PdfEmbedSurface } from "./artifact-editor-surfaces";

const artifactChange: OrgChange = {
  type: "artifact",
  action: "updated",
  artifactId: "artifact-1",
  runId: "run-1",
  threadId: "thread-1",
};
const idle = { loading: false, saving: false, dirty: false } as const;

describe("byte-authoritative PDF detection", () => {
  test("a published PDF (pdf-text, null state) is byte-authoritative", () => {
    expect(isByteAuthoritativePdf("pdf-text", null)).toBe(true);
  });

  test("a text-authored PDF (state carries pdfText) stays in the text editor", () => {
    expect(isByteAuthoritativePdf("pdf-text", "Cover letter\n")).toBe(false);
    expect(isByteAuthoritativePdf("pdf-text", "")).toBe(false);
  });

  test("a null state in any other mode is not a byte PDF", () => {
    expect(isByteAuthoritativePdf("source-document", null)).toBe(false);
    expect(isByteAuthoritativePdf("rich-document", null)).toBe(false);
    expect(isByteAuthoritativePdf("sheet-grid", null)).toBe(false);
  });
});

describe("live-reload gate for artifact change signals", () => {
  test("an open, clean workpiece reloads when its own signal arrives", () => {
    expect(shouldReloadOnArtifactSignal(artifactChange, "artifact-1", idle)).toBe(true);
  });

  test("a dirty editor is never clobbered - it keeps its edits", () => {
    expect(
      shouldReloadOnArtifactSignal(artifactChange, "artifact-1", { ...idle, dirty: true }),
    ).toBe(false);
  });

  test("an in-flight load or save defers the reload", () => {
    expect(
      shouldReloadOnArtifactSignal(artifactChange, "artifact-1", { ...idle, loading: true }),
    ).toBe(false);
    expect(
      shouldReloadOnArtifactSignal(artifactChange, "artifact-1", { ...idle, saving: true }),
    ).toBe(false);
  });

  test("signals for other artifacts or other change types are ignored", () => {
    expect(shouldReloadOnArtifactSignal(artifactChange, "artifact-2", idle)).toBe(false);
    const runChange: OrgChange = {
      type: "run",
      action: "running",
      runId: "run-1",
      threadId: "thread-1",
    };
    expect(shouldReloadOnArtifactSignal(runChange, "artifact-1", idle)).toBe(false);
  });
});

describe("byte-PDF surfaces never leak raw bytes", () => {
  test("the rendered surface embeds the PDF and states the honest note", () => {
    const html = renderToStaticMarkup(<PdfEmbedSurface url="/api/artifacts/a1/preview?v=2" />);
    expect(html).toContain('type="application/pdf"');
    expect(html).toContain("/api/artifacts/a1/preview?v=2");
    expect(html).toContain("Open the PDF");
    expect(html).toContain("Page reorder and delete are the supported revisions");
    expect(html).not.toContain("%PDF");
  });

  test("the Code view shows a binary summary, never the raw bytes", () => {
    const html = renderToStaticMarkup(<PdfBinaryCodeView sizeBytes={3_391} />);
    expect(html).toContain("Binary PDF source (3 KB) - not text");
    expect(html).not.toContain("%PDF");
  });
});
