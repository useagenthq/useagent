import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_AUTHORING_PROFILES,
  ARTIFACT_AUTHORING_ACTIONS,
  ARTIFACT_FIDELITY,
  ARTIFACT_LEGACY_WORKPIECE_ACTIONS,
  artifactActionContractFor,
  artifactCapabilitiesFor,
  artifactFidelityFor,
  artifactWorkpieceExports,
  artifactSurfaceCategoryFor,
  canPreviewInline,
  contentTypeForName,
  DOCX_CONTENT_TYPE,
  inferWorkpieceKind,
  isArtifactWorkpieceState,
  MAX_RICH_WORKPIECE_SOURCE_BYTES,
  normalizeArtifactRichHtml,
  PDF_CONTENT_TYPE,
  parseArtifactCsv,
  PPTX_CONTENT_TYPE,
  serializeArtifactCsv,
  XLSX_CONTENT_TYPE,
} from "../src";

const baseArtifact = {
  id: "artifact-1",
  run_id: "run-1",
  thread_id: "thread-1",
  source_path: "/workspace/report.pdf",
  size_bytes: 42,
  sha256: "a".repeat(64),
  created_at: "2026-08-10T00:00:00.000Z",
  preview_url: "/api/artifacts/artifact-1/content",
  download_url: "/api/artifacts/artifact-1/content?download=1",
  workpiece: null,
};

describe("artifact workspace capabilities", () => {
  test("keeps active web content attachment-only while allowing safe inline previews", () => {
    expect(contentTypeForName("report.pdf")).toBe(PDF_CONTENT_TYPE);
    expect(contentTypeForName("page.html")).toBe("text/html; charset=utf-8");
    expect(canPreviewInline(PDF_CONTENT_TYPE)).toBe(true);
    expect(canPreviewInline("text/html; charset=utf-8")).toBe(false);
    expect(canPreviewInline("image/svg+xml")).toBe(false);
    expect(artifactCapabilitiesFor({
      name: "photo.png",
      content_type: "image/png",
      size_bytes: 42,
    }).preview).toEqual({ inline: true, renderer: "image" });
    expect(artifactCapabilitiesFor({
      name: "page.html",
      content_type: "text/html; charset=utf-8",
      size_bytes: 42,
    })).toMatchObject({
      preview: { inline: false, renderer: null },
      actions: ["download"],
    });
  });

  test("describes Office formats as companion-editable or download-only", () => {
    expect(artifactCapabilitiesFor({
      name: "brief.docx",
      content_type: DOCX_CONTENT_TYPE,
      size_bytes: MAX_RICH_WORKPIECE_SOURCE_BYTES,
    })).toMatchObject({
      kind: "document",
      preview: { inline: false, renderer: null },
      actions: ["download"],
      edit: { mode: "companion", kind: "document", state: "html", companionExtension: "html" },
    });
    expect(artifactCapabilitiesFor({
      name: "model.xlsx",
      content_type: XLSX_CONTENT_TYPE,
      size_bytes: MAX_RICH_WORKPIECE_SOURCE_BYTES,
    })).toMatchObject({
      kind: "spreadsheet",
      preview: { inline: false, renderer: null },
      edit: { mode: "companion", kind: "spreadsheet", state: "csv", companionExtension: "csv" },
    });
    expect(artifactCapabilitiesFor({
      name: "slides.pptx",
      content_type: PPTX_CONTENT_TYPE,
      size_bytes: 42,
    })).toMatchObject({
      kind: "presentation",
      preview: { inline: false, renderer: null },
      edit: { mode: "companion", kind: "presentation", state: "slides" },
    });
  });

  test("keeps PDF workpieces canonical and over-limit Office sources download-only", () => {
    expect(artifactCapabilitiesFor({
      name: "report.pdf",
      content_type: PDF_CONTENT_TYPE,
      size_bytes: 42,
    })).toMatchObject({
      kind: "pdf",
      preview: { inline: true, renderer: "pdf" },
      edit: { mode: "companion", kind: "pdf", state: "pdfText" },
    });
    expect(artifactCapabilitiesFor({
      name: "huge.docx",
      content_type: DOCX_CONTENT_TYPE,
      size_bytes: MAX_RICH_WORKPIECE_SOURCE_BYTES + 1,
    }).edit).toBeNull();
  });

  test("narrows supported actions to actions available on the concrete artifact", () => {
    const workpiece = {
      kind: "document" as const,
      source_version: "a".repeat(64),
      state_revision: 0,
      state_url: "/api/artifacts/artifact-1/workpiece",
      export_url: "/api/artifacts/artifact-1/workpiece/export",
      exports: artifactWorkpieceExports("document"),
      actions: ARTIFACT_LEGACY_WORKPIECE_ACTIONS,
    };
    expect(artifactActionContractFor({
      ...baseArtifact,
      name: "brief.docx",
      content_type: DOCX_CONTENT_TYPE,
      workpiece,
    }).actions).toEqual(["download", "edit", "export"]);
    expect(artifactActionContractFor({
      ...baseArtifact,
      name: "brief.docx",
      content_type: DOCX_CONTENT_TYPE,
      workpiece: { ...workpiece, export_url: undefined, exports: undefined },
    }).actions).toEqual(["download", "edit"]);
    expect(artifactActionContractFor({
      ...baseArtifact,
      name: "brief.docx",
      content_type: DOCX_CONTENT_TYPE,
    })).toMatchObject({
      edit: null,
      actions: ["download"],
    });
  });

  test("publishes correlated authoring profiles with native and companion truth", () => {
    expect(ARTIFACT_AUTHORING_ACTIONS).toEqual(["create", "publish"]);
    expect(ARTIFACT_AUTHORING_PROFILES.map((profile) => ({
      kind: profile.kind,
      defaultName: profile.defaultName,
      companionExtension: profile.companion.extension,
      exports: profile.exports.map((item) => item.format),
      actions: profile.actions,
    }))).toEqual([
      {
        kind: "document",
        defaultName: "Untitled document.docx",
        companionExtension: "html",
        exports: ["docx", "html", "text"],
        actions: ["create", "publish"],
      },
      {
        kind: "spreadsheet",
        defaultName: "Untitled spreadsheet.xlsx",
        companionExtension: "csv",
        exports: ["xlsx", "csv"],
        actions: ["create", "publish"],
      },
      {
        kind: "presentation",
        defaultName: "Untitled presentation.pptx",
        companionExtension: "json",
        exports: ["pptx", "json"],
        actions: ["create", "publish"],
      },
      {
        kind: "pdf",
        defaultName: "Untitled PDF.pdf",
        companionExtension: "txt",
        exports: ["pdf", "text"],
        actions: ["create", "publish"],
      },
    ]);
    expect(ARTIFACT_AUTHORING_PROFILES.map((profile) => profile.description).join(" "))
      .toContain("PPTX presentation with a JSON companion");
    expect(ARTIFACT_AUTHORING_PROFILES.map((profile) => profile.description).join(" "))
      .toContain("PDF document with a text companion");
  });

  test("keeps direct text and CSV workpieces bounded to their current state shapes", () => {
    expect(inferWorkpieceKind("notes.md", "text/markdown; charset=utf-8")).toBe("document");
    expect(inferWorkpieceKind("metrics.csv", "text/csv; charset=utf-8")).toBe("spreadsheet");
    expect(isArtifactWorkpieceState("document", { text: "# Notes" })).toBe(true);
    expect(isArtifactWorkpieceState("document", { csv: "wrong" })).toBe(false);
    expect(isArtifactWorkpieceState("spreadsheet", { csv: "name,value\nrun,42" })).toBe(true);
    expect(isArtifactWorkpieceState("spreadsheet", { html: "<p>wrong</p>" })).toBe(false);
    expect(isArtifactWorkpieceState("presentation", {
      slides: [{ title: "Intro", body: "Body", notes: "Notes" }],
    })).toBe(true);
    expect(isArtifactWorkpieceState("pdf", { pdfText: "Extracted text" })).toBe(true);
  });

  test("preserves artifact rail category behavior", () => {
    expect(artifactSurfaceCategoryFor({ name: "page.html", content_type: "text/html" })).toBe(
      "docs",
    );
    expect(artifactSurfaceCategoryFor({ name: "icon.svg", content_type: "image/svg+xml" })).toBe(
      "media",
    );
    expect(artifactSurfaceCategoryFor({
      name: "deck.pptx",
      content_type: "application/octet-stream",
    })).toBe("docs");
    expect(artifactSurfaceCategoryFor({ name: "archive.zip", content_type: "application/zip" }))
      .toBe("files");
  });

  test("round-trips quoted and multiline CSV cells for every artifact consumer", () => {
    const source = 'name,notes\n"ACME, Inc.","line 1\nline 2"\nquote,"a ""b"""';
    const rows = parseArtifactCsv(source);

    expect(rows).toEqual([
      ["name", "notes"],
      ["ACME, Inc.", "line 1\nline 2"],
      ["quote", 'a "b"'],
    ]);
    expect(serializeArtifactCsv(rows)).toBe(source);
  });

  test("publishes one honest fidelity record per workpiece kind", () => {
    // Exactly the four canonical kinds, in profile order, no duplicates.
    expect(ARTIFACT_FIDELITY.map((entry) => entry.kind)).toEqual([
      "document",
      "spreadsheet",
      "presentation",
      "pdf",
    ]);

    for (const entry of ARTIFACT_FIDELITY) {
      expect(artifactFidelityFor(entry.kind)).toBe(entry);
      // Every kind states both what it keeps and what it drops - never silent.
      expect(entry.preserved.length).toBeGreaterThan(0);
      expect(entry.notPreserved.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.importNote.length).toBeGreaterThan(0);
      expect(["companion", "authored", "unsupported"]).toContain(entry.uploadImport);
    }

    // The one hard boundary the product must never fake: uploaded PDF editing.
    expect(artifactFidelityFor("pdf").uploadImport).toBe("unsupported");
    expect(artifactFidelityFor("pdf").importNote).toContain("cannot be imported");
    // Page-structure ops are recorded as preserved; content editing stays dropped.
    const pdfPreserved = artifactFidelityFor("pdf").preserved.join(" ").toLowerCase();
    expect(pdfPreserved).toContain("reorder");
    expect(pdfPreserved).toContain("delet");
    expect(artifactFidelityFor("pdf").notPreserved.join(" ").toLowerCase()).toContain("content");
    // Companion kinds are labelled as companions, not rich round-trips.
    for (const kind of ["document", "spreadsheet", "presentation"] as const) {
      expect(artifactFidelityFor(kind).uploadImport).toBe("companion");
    }
  });

  test("validates browser-normalized rich HTML with attribute context intact", () => {
    const browserTable =
      '<table><tbody><tr><td colspan="2">Safe</td></tr></tbody></table>';
    expect(normalizeArtifactRichHtml(browserTable)).toBe(browserTable);
    expect(normalizeArtifactRichHtml('<p href="https://example.com">Wrong element</p>')).toBeNull();
    expect(normalizeArtifactRichHtml('<td colspan="0">Invalid span</td>')).toBeNull();
    expect(normalizeArtifactRichHtml('<a href="javascript:alert(1)">Unsafe link</a>')).toBeNull();
  });

});
