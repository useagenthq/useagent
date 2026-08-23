import { describe, expect, test } from "bun:test";
import type { ArtifactWorkpieceResult } from "@useagent/agent-client";
import {
  DEFAULT_DOCUMENT_THEME,
  migrateHtmlToDocument,
  normalizeArtifactRichHtml,
} from "@useagent/artifact-workspace";
import {
  artifactEditorMode,
  parseCsv,
  richDocumentTemplate,
  sanitizeRichHtml,
  serializeCsv,
  stateValue,
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
    expect(artifactEditorMode(artifact("spreadsheet", "Model.xlsx"))).toBe("sheet-grid");
    expect(artifactEditorMode(artifact("spreadsheet", "Model.csv"))).toBe("sheet-grid");
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

  test("keeps rich document editing bounded", () => {
    expect(richDocumentTemplate("<unsafe>.docx")).toContain("&lt;unsafe&gt;");
  });

  test("surfaces the themed document HTML body (and plain text) to the editor", () => {
    const doc = migrateHtmlToDocument("<h1>Brief</h1><p>Body</p>", DEFAULT_DOCUMENT_THEME)!;
    const result = (state: unknown) => ({ state } as unknown as ArtifactWorkpieceResult);
    expect(stateValue(result({ document: doc }))).toBe("<h1>Brief</h1><p>Body</p>");
    expect(stateValue(result({ text: "plain source" }))).toBe("plain source");
    expect(stateValue(result(null))).toBeNull();
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
