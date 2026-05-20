import { describe, expect, test } from "bun:test";
import { normalizeArtifactRichHtml } from "@skynet/artifact-workspace";
import {
  artifactEditorMode,
  isSheetWithinGridLimit,
  parseCsv,
  richDocumentTemplate,
  sanitizeRichHtml,
  serializeCsv,
} from "./artifact-editor-model";

describe("artifact editor model", () => {
  test("selects editor surfaces from the shared edit contract", () => {
    const artifact = (kind: "document" | "spreadsheet" | "presentation" | "pdf", name: string) => ({
      name,
      content_type: "application/octet-stream",
      size_bytes: 42,
      workpiece: { kind, actions: ["preview", "download", "edit", "export"] as const },
    });

    expect(artifactEditorMode(artifact("document", "Plan.docx"))).toBe("rich-document");
    expect(artifactEditorMode(artifact("spreadsheet", "Model.xlsx"))).toBe("grid");
    expect(artifactEditorMode(artifact("spreadsheet", "Model.csv"))).toBe("sheet-source");
    expect(artifactEditorMode(artifact("presentation", "Deck.pptx"))).toBe("slides-json");
    expect(artifactEditorMode(artifact("pdf", "Report.pdf"))).toBe("pdf-text");
  });

  test("round-trips quoted CSV cells", () => {
    const rows = parseCsv('name,notes\n"ACME, Inc.","line 1\nline 2"\nquote,"a ""b"""');
    expect(rows).toEqual([
      ["name", "notes"],
      ["ACME, Inc.", "line 1\nline 2"],
      ["quote", 'a "b"'],
    ]);
    expect(serializeCsv(rows)).toBe('name,notes\n"ACME, Inc.","line 1\nline 2"\nquote,"a ""b"""');
  });

  test("keeps rich document and sheet editing bounded", () => {
    expect(richDocumentTemplate("<unsafe>.docx")).toContain("&lt;unsafe&gt;");
    expect(isSheetWithinGridLimit([Array.from({ length: 26 }, () => "")])).toBe(true);
    expect(isSheetWithinGridLimit([Array.from({ length: 27 }, () => "")])).toBe(false);
  });

  test("never returns rich HTML that the shared save contract rejects", () => {
    for (const browserHtml of [
      '<p href="https://example.com">Wrong element</p>',
      '<table><tbody><tr><td colspan="0">Invalid span</td></tr></tbody></table>',
      '<a href="javascript:alert(1)">Unsafe link</a>',
    ]) {
      const sanitized = sanitizeRichHtml(browserHtml);
      expect(normalizeArtifactRichHtml(sanitized)).toBe(sanitized);
    }
  });
});
