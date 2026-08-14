import { describe, expect, test } from "bun:test";
import {
  isRichDocumentArtifact,
  isRichSpreadsheetArtifact,
  isSheetWithinGridLimit,
  parseCsv,
  richDocumentTemplate,
  serializeCsv,
} from "./artifact-editor-model";

describe("artifact editor model", () => {
  test("classifies Office workpieces without treating every binary as editable", () => {
    expect(
      isRichDocumentArtifact({
        name: "Plan.docx",
        content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe(true);
    expect(
      isRichSpreadsheetArtifact({
        name: "Model.xlsx",
        content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toBe(true);
    expect(isRichDocumentArtifact({ name: "archive.zip", content_type: "application/zip" })).toBe(
      false,
    );
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
});
