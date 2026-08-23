import { describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { decodePDFRawStream, PDFDocument, PDFRawStream, StandardFonts } from "pdf-lib";
import {
  DECK_THEME_PRESETS,
  migrateSlidesToDeck,
  type DeckBlock,
  type PresentationDeck,
  type Workbook,
} from "@useagent/artifact-workspace";
import {
  applyPdfPageOperation,
  ARTIFACT_BUNDLE_CONTENT_TYPE,
  buildArtifactBundle,
  DOCX_CONTENT_TYPE,
  extractDocxText,
  extractPptxDeck,
  extractPptxSlides,
  extractXlsxWorkbook,
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

  test("renders a workbook to XLSX faithfully: sheet names, a formula, a numFmt, bold + fill", async () => {
    const workbook: Workbook = {
      schemaVersion: 2,
      activeSheetId: "sheet-1",
      sheets: [
        {
          id: "sheet-1",
          name: "Summary",
          rowCount: 4,
          colCount: 2,
          colWidths: { A: 160 },
          cells: {
            A1: { v: "Region", fmt: { bold: true, fill: "#dbeafe" } },
            B1: { v: "Pipeline", fmt: { bold: true } },
            A2: { v: "APAC" },
            B2: { v: 1200000, fmt: { numFmt: "currency" } },
            A3: { v: "EMEA" },
            B3: { v: 980000, fmt: { numFmt: "currency" } },
            A4: { v: "Total" },
            // A real formula cell with a cached result.
            B4: { v: 2180000, f: "=SUM(B2:B3)" },
          },
        },
        { id: "sheet-2", name: "Data", rowCount: 1, colCount: 1, cells: { A1: { v: "raw" } } },
      ],
    };

    const output = await renderArtifactExport({ workbook }, "xlsx");
    expect(output.contentType).toBe(XLSX_CONTENT_TYPE);

    // Byte-open the XLSX and inspect the real cell structure exceljs wrote.
    const reloaded = new ExcelJS.Workbook();
    const buffer = Buffer.from(output.bytes);
    await reloaded.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    expect(reloaded.creator).toBe("useAgent");
    expect(reloaded.worksheets.map((sheet) => sheet.name)).toEqual(["Summary", "Data"]);
    const summary = reloaded.getWorksheet("Summary")!;
    expect(summary.getCell("B4").formula).toBe("SUM(B2:B3)"); // a real formula, not text
    expect(summary.getCell("B2").numFmt).toContain("$"); // currency number format
    expect(summary.getCell("A1").font?.bold).toBe(true); // bold header cell
    const fill = summary.getCell("A1").fill as { fgColor?: { argb?: string } };
    expect(fill.fgColor?.argb).toBe("FFDBEAFE"); // cell fill color
    expect(summary.getColumn(1).width).toBeGreaterThan(0); // column width applied

    // Round-trips back into the canonical workbook through import.
    const imported = await extractXlsxWorkbook(output.bytes);
    expect(imported.sheets.map((sheet) => sheet.name)).toEqual(["Summary", "Data"]);
    const cells = imported.sheets[0]!.cells;
    expect(cells.B4?.f).toBe("=SUM(B2:B3)");
    expect(cells.A1?.fmt?.bold).toBe(true);
    expect(cells.A1?.fmt?.fill).toBe("#dbeafe");
    expect(cells.B2?.fmt?.numFmt).toBe("currency");

    // The CSV canonical export downgrades the active sheet to values.
    const csv = await renderArtifactExport({ workbook }, "csv");
    expect(new TextDecoder().decode(csv.bytes)).toContain("APAC,1200000");
  });

  test("brands text-only XLSX exports with the useAgent creator", async () => {
    const output = await renderArtifactExport({ text: "Region,Pipeline\nAPAC,1200000" }, "xlsx");
    const reloaded = new ExcelJS.Workbook();
    const buffer = Buffer.from(output.bytes);
    await reloaded.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

    expect(reloaded.creator).toBe("useAgent");
  });

  test("renders a themed deck to PPTX: slide count, text runs, background fill, shape, notes", async () => {
    // Sky preset carries a gradient background (start #1d5fd0); the export maps a
    // gradient to a solid slide fill of its start color.
    const base = migrateSlidesToDeck(
      [
        { title: "Release", body: "Ship it", notes: "Check metrics" },
        { title: "Metrics", body: "All green" },
      ],
      DECK_THEME_PRESETS.find((preset) => preset.id === "sky")!.theme,
    );
    const shape: DeckBlock = {
      id: "s1-shape",
      type: "shape",
      x: 8,
      y: 82,
      w: 30,
      h: 6,
      content: "",
      style: { fill: "#ffd166", radius: 8 },
    };
    const deck: PresentationDeck = {
      ...base,
      slides: base.slides.map((slide, index) =>
        index === 0 ? { ...slide, blocks: [...slide.blocks, shape] } : slide
      ),
    };

    const output = await renderArtifactExport({ deck }, "pptx");
    expect(output.contentType).toBe(PPTX_CONTENT_TYPE);

    // Byte-open the PPTX (a zip) and inspect the slide XML the deck produced.
    const zip = await JSZip.loadAsync(output.bytes);
    const slideNames = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name)
    );
    expect(slideNames.length).toBe(2); // one slide per deck slide

    const slide1 = (await zip.file("ppt/slides/slide1.xml")?.async("string")) ?? "";
    expect(slide1).toContain("<a:t>Release</a:t>"); // heading text run present
    expect(slide1).toContain("<a:t>Ship it</a:t>"); // body text run present
    // Background fill is set from the theme (gradient start color, upper-cased).
    expect(slide1).toMatch(/<p:bg>[\s\S]*<a:srgbClr val="1D5FD0"/);
    expect(slide1).toContain('<a:srgbClr val="FFD166"'); // shape fill color

    // Round-trips back to title/body through extraction.
    const slides = await extractPptxSlides(output.bytes);
    expect(slides[0]).toMatchObject({ title: "Release" });
    expect(slides[0]?.body).toContain("Ship it");

    // Speaker notes survive as a notes slide.
    expect(Object.keys(zip.files).some((name) => /notesSlide\d+\.xml$/.test(name))).toBe(true);
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
    ["XLSX", extractXlsxWorkbook],
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

  test("preserves rich document formatting and theme when exporting a themed document to DOCX", async () => {
    const html =
      '<h1>Quarterly Report</h1>' +
      '<p>Revenue was <strong>up 20%</strong> and <em>margins improved</em>. ' +
      'See <a href="https://loop.dev">Loop</a>.</p>' +
      "<ul><li>North region</li><li>South region</li></ul>" +
      "<ol><li>First step</li><li>Second step</li></ol>" +
      '<table><tbody><tr><th>Metric</th><th>Value</th></tr>' +
      '<tr><td colspan="2">Latency 42ms</td></tr></tbody></table>';
    // Distinct theme colors so the DOCX mapping is unambiguous in the assertions.
    const document_ = {
      document: {
        schemaVersion: 2 as const,
        theme: {
          background: { type: "color" as const, color: "#223344" },
          heading: "#ff0000",
          body: "#00ff00",
          accent: "#0000ff",
        },
        html,
      },
    };
    const output = await renderArtifactExport(document_, "docx");
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
    // Theme maps honestly: a solid page background, heading + body run colors.
    expect(document).toMatch(/<w:background[^>]*w:color="223344"/); // page background
    expect(document).toMatch(/<w:color w:val="FF0000"/); // heading color
    expect(document).toMatch(/<w:color w:val="00FF00"/); // body color

    // Content still round-trips through extraction.
    const text = await extractDocxText(output.bytes);
    expect(text).toContain("Quarterly Report");
    expect(text).toContain("up 20%");
    expect(text).toContain("North region");
    expect(text).toContain("Latency 42ms");
  });

  test("round-trips a PPTX export back into an editable native deck", async () => {
    const deck = {
      schemaVersion: 2 as const,
      theme: {
        background: { type: "color" as const, color: "#101828" },
        heading: "#ffffff",
        body: "#c8c8e0",
        accent: "#5eb0ff",
      },
      slides: [
        {
          id: "s1",
          background: { type: "color" as const, color: "#0b1220" },
          blocks: [
            {
              id: "h",
              type: "heading" as const,
              x: 6,
              y: 8,
              w: 88,
              h: 17,
              content: "Quarterly Review",
              style: { fontSize: 96, bold: true, align: "left" as const, color: "#ffd166" },
            },
            {
              id: "b",
              type: "text" as const,
              x: 6,
              y: 30,
              w: 88,
              h: 50,
              content: "First point\nSecond point",
              style: { fontSize: 44, align: "center" as const, color: "#c8c8e0" },
            },
          ],
        },
      ],
    };
    const output = await renderArtifactExport({ deck }, "pptx");
    const imported = await extractPptxDeck(output.bytes);
    expect(imported).not.toBeNull();
    expect(imported!.images).toHaveLength(0);
    expect(imported!.deck.slides).toHaveLength(1);

    const slide = imported!.deck.slides[0]!;
    // Solid slide background is recovered.
    expect(slide.background).toEqual({ type: "color", color: "#0b1220" });

    const heading = slide.blocks.find((block) => block.type === "heading");
    const body = slide.blocks.find((block) => block.type === "text");
    expect(heading).toBeDefined();
    expect(body).toBeDefined();

    // Position round-trips exactly (EMU math mirrors the export).
    expect(Math.round(heading!.x)).toBe(6);
    expect(Math.round(heading!.y)).toBe(8);
    expect(Math.round(heading!.w)).toBe(88);
    expect(Math.round(heading!.h)).toBe(17);

    // Content, size, weight, color, and alignment are preserved.
    expect(heading!.content).toBe("Quarterly Review");
    expect(heading!.style?.fontSize).toBe(96);
    expect(heading!.style?.bold).toBe(true);
    expect(heading!.style?.color).toBe("#ffd166");
    expect(heading!.style?.align).toBe("left");

    expect(body!.content).toBe("First point\nSecond point");
    expect(body!.style?.fontSize).toBe(44);
    expect(body!.style?.align).toBe("center");
    expect(body!.style?.color).toBe("#c8c8e0");
  });

  test("skips import when a PPTX has no parsable text (behaves as download-only)", async () => {
    // A deck with only a shape block yields no text boxes -> null (no native import).
    const deck = {
      schemaVersion: 2 as const,
      theme: {
        background: { type: "color" as const, color: "#101828" },
        heading: "#ffffff",
        body: "#c8c8e0",
        accent: "#5eb0ff",
      },
      slides: [
        {
          id: "s1",
          blocks: [
            {
              id: "shape",
              type: "shape" as const,
              x: 10,
              y: 10,
              w: 30,
              h: 20,
              content: "",
              style: { fill: "#5eb0ff" },
            },
          ],
        },
      ],
    };
    const output = await renderArtifactExport({ deck }, "pptx");
    expect(await extractPptxDeck(output.bytes)).toBeNull();
  });

  test("extracts embedded PPTX images: full-slide -> background, smaller -> block", async () => {
    // 1x1 PNGs embedded via pptxgenjs land in ppt/media referenced by slide <p:pic>;
    // the parser recovers bytes + geometry and marks a full-slide picture as the
    // slide background (generated-art case) and a smaller one as a positioned block.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "DECK", width: 10, height: 5.625 });
    pptx.layout = "DECK";
    const slide = pptx.addSlide();
    slide.addText("Cover", { x: 0.5, y: 0.4, w: 8, h: 1, fontSize: 40 });
    slide.addImage({ data: `image/png;base64,${png}`, x: 0, y: 0, w: 10, h: 5.625 }); // full-slide
    slide.addImage({ data: `image/png;base64,${png}`, x: 1, y: 2, w: 3, h: 2 }); // positioned
    const written = await pptx.write({ outputType: "nodebuffer" });
    const bytes = written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBuffer);

    const imported = await extractPptxDeck(bytes);
    expect(imported).not.toBeNull();
    expect(imported!.images).toHaveLength(2);
    const background = imported!.images.find((image) => image.role === "background");
    const block = imported!.images.find((image) => image.role === "block");
    expect(background).toBeDefined();
    expect(block).toBeDefined();
    expect(background!.contentType).toBe("image/png");
    expect(background!.bytes.byteLength).toBeGreaterThan(0);
    expect(block!.slideIndex).toBe(0);
    expect(Math.round(block!.x)).toBe(10); // 1in / 10in
    expect(Math.round(block!.w)).toBe(30); // 3in / 10in
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
