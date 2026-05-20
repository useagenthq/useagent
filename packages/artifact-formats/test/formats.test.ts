import { describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { decodePDFRawStream, PDFDocument, PDFRawStream } from "pdf-lib";
import {
  DOCX_CONTENT_TYPE,
  extractDocxText,
  extractPptxSlides,
  extractXlsxCsv,
  PDF_CONTENT_TYPE,
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
});

const decoder = new TextDecoder();

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
