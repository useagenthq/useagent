import { describe, expect, test } from "bun:test";
import {
  DOCX_CONTENT_TYPE as CANONICAL_DOCX_CONTENT_TYPE,
  PDF_CONTENT_TYPE as CANONICAL_PDF_CONTENT_TYPE,
  PPTX_CONTENT_TYPE as CANONICAL_PPTX_CONTENT_TYPE,
  XLSX_CONTENT_TYPE as CANONICAL_XLSX_CONTENT_TYPE,
  type ArtifactPresentationSlide,
  type ArtifactWorkpieceState,
} from "../../artifact-workspace/src";
import {
  DOCX_CONTENT_TYPE,
  PDF_CONTENT_TYPE,
  PPTX_CONTENT_TYPE,
  type PresentationSlide,
  type WorkpieceState,
  XLSX_CONTENT_TYPE,
} from "../src";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Condition extends true> = Condition;

type _PresentationSlideIsCanonical = Assert<Equal<PresentationSlide, ArtifactPresentationSlide>>;
type _WorkpieceStateIsCanonical = Assert<Equal<WorkpieceState, ArtifactWorkpieceState>>;

describe("artifact format contracts", () => {
  test("re-exports MIME constants from the canonical browser-safe package", () => {
    expect({
      DOCX_CONTENT_TYPE,
      XLSX_CONTENT_TYPE,
      PPTX_CONTENT_TYPE,
      PDF_CONTENT_TYPE,
    }).toEqual({
      DOCX_CONTENT_TYPE: CANONICAL_DOCX_CONTENT_TYPE,
      XLSX_CONTENT_TYPE: CANONICAL_XLSX_CONTENT_TYPE,
      PPTX_CONTENT_TYPE: CANONICAL_PPTX_CONTENT_TYPE,
      PDF_CONTENT_TYPE: CANONICAL_PDF_CONTENT_TYPE,
    });
  });

  test("declares the canonical package as an internal workspace dependency", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(manifest.dependencies?.["@skynet/artifact-workspace"]).toBe(
      "file:../artifact-workspace",
    );

    const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(source).toContain('from "@skynet/artifact-workspace"');
    expect(source).not.toMatch(
      /export const (?:DOCX|XLSX|PPTX|PDF)_CONTENT_TYPE/,
    );
    expect(source).not.toMatch(/export (?:interface PresentationSlide|type WorkpieceState)/);
    expect(source).not.toMatch(/const MAX_OFFICE_(?:ARCHIVE|OUTPUT)_BYTES/);
    expect(source).toContain("MAX_RICH_WORKPIECE_SOURCE_BYTES");
    expect(source).toContain("MAX_WORKPIECE_STATE_BYTES");
  });

  test("exposes only the aggregate artifact render entry point", async () => {
    const formats = await import("../src");
    expect(formats).toHaveProperty("renderArtifactExport");
    for (const helper of [
      "renderDocx",
      "renderXlsx",
      "renderPptx",
      "renderPdf",
      "renderCanonical",
      "renderNative",
    ]) {
      expect(formats).not.toHaveProperty(helper);
    }
  });
});
