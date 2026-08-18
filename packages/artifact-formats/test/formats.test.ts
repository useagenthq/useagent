import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { decodePDFRawStream, PDFDocument, PDFRawStream, StandardFonts } from "pdf-lib";
import {
  applyPdfPageOperation,
  ARTIFACT_BUNDLE_CONTENT_TYPE,
  buildArtifactBundle,
  DOCX_CONTENT_TYPE,
  extractDocxText,
  extractPptxSlides,
  extractXlsxCsv,
  PDF_CONTENT_TYPE,
  pdfPageCount,
  PdfPageOperationError,
  PPTX_CONTENT_TYPE,
  renderArtifactExport,
  UnsupportedPdfUnicodeError,
  XLSX_CONTENT_TYPE,
} from "../src";

describe("artifact native formats", () => {
  test("renders and extracts DOCX text", async () => {
    const output = await renderArtifactExport({ text: "# Brief\n\nHello Loop" }, "docx");
    expect(output.contentType).toBe(DOCX_CONTENT_TYPE);
    expect(output.bytes.byteLength).toBeGreaterThan(1_000);
    expect(await extractDocxText(output.bytes)).toContain("Hello Loop");
  });

  test("renders and extracts XLSX CSV", async () => {
    const output = await renderArtifactExport({ csv: "Name,Value\nLatency,42" }, "xlsx");
    expect(output.contentType).toBe(XLSX_CONTENT_TYPE);
    expect(await extractXlsxCsv(output.bytes)).toContain("Latency,42");
  });

  test("renders and extracts PPTX slide text", async () => {
    const output = await renderArtifactExport({
      slides: [{ title: "Release", body: "Ship it", notes: "Check metrics" }],
    }, "pptx");
    expect(output.contentType).toBe(PPTX_CONTENT_TYPE);
    const slides = await extractPptxSlides(output.bytes);
    expect(slides[0]).toMatchObject({ title: "Release" });
    expect(slides[0]?.body).toContain("Ship it");
  });

  test("renders supported PDF text into the PDF content stream", async () => {
    const output = await renderArtifactExport({ pdfText: "Quarterly report" }, "pdf");
    expect(output.contentType).toBe(PDF_CONTENT_TYPE);
    expect(await decodedPdfStreams(output.bytes)).toContain(
      "<517561727465726C79207265706F7274> Tj",
    );

    const canonical = await renderArtifactExport({ pdfText: "Quarterly report" }, "text");
    expect(decoder.decode(canonical.bytes)).toBe("Quarterly report");
  });

  test("rejects unsupported PDF Unicode instead of replacing it", async () => {
    try {
      await renderArtifactExport({ pdfText: "Quarterly report 🚀 東京" }, "pdf");
      throw new Error("expected PDF export to reject unsupported Unicode");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedPdfUnicodeError);
      expect(error).toMatchObject({
        code: "PDF_UNSUPPORTED_UNICODE",
        unsupportedCharacters: ["🚀", "東", "京"],
      });
    }
  });

  test("reorders PDF pages as new bytes without touching the source", async () => {
    const fixture = await threePageFixture();
    expect(await pdfPageCount(fixture)).toBe(3);

    const reordered = await applyPdfPageOperation(fixture, { type: "reorder", order: [2, 0, 1] });
    // Page identity is carried by width (201/202/203); reordering rewrites order.
    expect(await pageWidths(reordered)).toEqual([203, 201, 202]);
    // Source bytes are untouched by the pure operation.
    expect(await pageWidths(fixture)).toEqual([201, 202, 203]);
    // Every page's drawn marker text survives the copy, none is lost.
    const streams = await decodedPdfStreams(reordered);
    for (const marker of ["<5031>", "<5032>", "<5033>"]) expect(streams).toContain(marker);
  });

  test("deletes PDF pages, keeping count and remaining order", async () => {
    const fixture = await threePageFixture();
    const deleted = await applyPdfPageOperation(fixture, { type: "delete", pages: [1] });
    expect(await pdfPageCount(deleted)).toBe(2);
    expect(await pageWidths(deleted)).toEqual([201, 203]);
    const streams = await decodedPdfStreams(deleted);
    expect(streams).toContain("<5031>"); // page 1 marker "P1"
    expect(streams).toContain("<5033>"); // page 3 marker "P3"
    expect(streams).not.toContain("<5032>"); // deleted page 2 marker "P2" is gone
  });

  test("rejects invalid PDF page operations instead of corrupting bytes", async () => {
    const fixture = await threePageFixture();
    await expect(applyPdfPageOperation(fixture, { type: "reorder", order: [0, 1] })).rejects
      .toBeInstanceOf(PdfPageOperationError);
    await expect(applyPdfPageOperation(fixture, { type: "reorder", order: [0, 1, 1] })).rejects
      .toThrow("duplicated");
    await expect(applyPdfPageOperation(fixture, { type: "delete", pages: [0, 1, 2] })).rejects
      .toThrow("cannot delete every page");
    await expect(applyPdfPageOperation(fixture, { type: "delete", pages: [9] })).rejects
      .toThrow("out of range");
    await expect(applyPdfPageOperation(new Uint8Array([1, 2, 3]), { type: "delete", pages: [0] }))
      .rejects.toBeInstanceOf(PdfPageOperationError);
  });

  for (const [format, extract] of [
    ["DOCX", extractDocxText],
    ["XLSX", extractXlsxCsv],
    ["PPTX", extractPptxSlides],
  ] as const) {
    test(`rejects excessive ${format} decompressed size before extraction`, async () => {
      await expect(extract(await zipWithDeclaredSize(50_000_001))).rejects.toThrow(
        "decompressed size limit",
      );
    });
  }

  test("rejects excessive Office import output", async () => {
    const output = await renderArtifactExport({ text: "a".repeat(1_000_000) }, "docx");
    await expect(extractDocxText(output.bytes)).rejects.toThrow("output size limit");
  });

  test("preserves rich document formatting when exporting HTML to DOCX", async () => {
    const html =
      '<h1>Quarterly Report</h1>' +
      '<p>Revenue was <strong>up 20%</strong> and <em>margins improved</em>. ' +
      'See <a href="https://loop.dev">Loop</a>.</p>' +
      "<ul><li>North region</li><li>South region</li></ul>" +
      "<ol><li>First step</li><li>Second step</li></ol>" +
      '<table><tbody><tr><th>Metric</th><th>Value</th></tr>' +
      '<tr><td colspan="2">Latency 42ms</td></tr></tbody></table>';
    const output = await renderArtifactExport({ html }, "docx");
    expect(output.contentType).toBe(DOCX_CONTENT_TYPE);

    const zip = await JSZip.loadAsync(output.bytes);
    const document = await zip.file("word/document.xml")?.async("string") ?? "";
    // Real DOCX structure, not flattened plain text.
    expect(document).toMatch(/Heading1/i); // <h1> maps to a Word heading style
    expect(document).toMatch(/<w:b\b/); // <strong> maps to a bold run
    expect(document).toMatch(/<w:i\b/); // <em> maps to an italic run
    expect(document).toMatch(/<w:tbl>/); // <table> maps to a Word table
    expect(document).toMatch(/<w:numPr>/); // <ol> maps to a numbered list
    expect(document).toMatch(/<w:gridSpan/); // colspan maps to a grid span

    // Content still round-trips through extraction.
    const text = await extractDocxText(output.bytes);
    expect(text).toContain("Quarterly Report");
    expect(text).toContain("up 20%");
    expect(text).toContain("North region");
    expect(text).toContain("Latency 42ms");
  });

  test("bundles multiple artifacts into one ZIP, disambiguating name collisions", async () => {
    const bundle = await buildArtifactBundle([
      { name: "report.txt", bytes: new TextEncoder().encode("alpha") },
      { name: "nested/dir/report.txt", bytes: new TextEncoder().encode("beta") },
      { name: "deck.pptx", bytes: new TextEncoder().encode("gamma") },
    ]);
    expect(bundle.contentType).toBe(ARTIFACT_BUNDLE_CONTENT_TYPE);
    expect(bundle.extension).toBe("zip");

    const zip = await JSZip.loadAsync(bundle.bytes);
    const names = Object.keys(zip.files).toSorted();
    expect(names).toEqual(["deck.pptx", "report (2).txt", "report.txt"]);
    // Path separators are stripped so entries stay flat and predictable.
    expect(names.some((name) => name.includes("/"))).toBe(false);
    expect(await zip.file("report.txt")?.async("string")).toBe("alpha");
    expect(await zip.file("report (2).txt")?.async("string")).toBe("beta");
  });
});

const decoder = new TextDecoder();

// Three pages whose per-page identity is encoded in a distinct width (201/202/
// 203) plus a drawn text marker ("P1"/"P2"/"P3", hex-encoded as <5031>..<5033>).
async function threePageFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  ["P1", "P2", "P3"].forEach((marker, index) => {
    const page = doc.addPage([201 + index, 300]);
    page.drawText(marker, { x: 20, y: 150, size: 24, font });
  });
  return doc.save();
}

async function pageWidths(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => Math.round(page.getWidth()));
}

async function decodedPdfStreams(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.context.enumerateIndirectObjects()
    .flatMap(([, object]) =>
      object instanceof PDFRawStream
        ? [decoder.decode(decodePDFRawStream(object).decode())]
        : []
    )
    .join("\n");
}

async function zipWithDeclaredSize(size: number): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("payload", "x");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const centralDirectory = bytes.findIndex((value, index) =>
    value === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x01 &&
    bytes[index + 3] === 0x02
  );
  expect(centralDirectory).toBeGreaterThanOrEqual(0);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    centralDirectory + 24,
    size,
    true,
  );
  return bytes;
}
