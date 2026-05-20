import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import PptxGenJS from "pptxgenjs";
import {
  DOCX_CONTENT_TYPE,
  MAX_RICH_WORKPIECE_SOURCE_BYTES,
  MAX_WORKPIECE_STATE_BYTES,
  PDF_CONTENT_TYPE,
  parseArtifactCsv as parseCsv,
  PPTX_CONTENT_TYPE,
  serializeArtifactCsv as serializeCsv,
  XLSX_CONTENT_TYPE,
  type ArtifactPresentationSlide as PresentationSlide,
  type ArtifactWorkpieceState as WorkpieceState,
} from "@skynet/artifact-workspace";

export {
  DOCX_CONTENT_TYPE,
  PDF_CONTENT_TYPE,
  PPTX_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  type PresentationSlide,
  type WorkpieceState,
};

export type NativeArtifactFormat = "docx" | "xlsx" | "pptx" | "pdf";
export type CanonicalArtifactFormat = "text" | "html" | "csv" | "json";
export type ArtifactExportFormat = NativeArtifactFormat | CanonicalArtifactFormat;

export interface FormatExport {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly extension: string;
}

export class UnsupportedPdfUnicodeError extends Error {
  readonly code = "PDF_UNSUPPORTED_UNICODE";
  readonly unsupportedCharacters: readonly string[];

  constructor(unsupportedCharacters: readonly string[]) {
    super(
      `PDF export cannot render these characters without a Unicode font: ${unsupportedCharacters.join(" ")}`,
    );
    this.name = "UnsupportedPdfUnicodeError";
    this.unsupportedCharacters = Object.freeze([...unsupportedCharacters]);
  }
}

const encoder = new TextEncoder();
const MAX_OFFICE_DECOMPRESSED_BYTES = 50_000_000;

type SizedZipEntry = JSZip.JSZipObject & {
  readonly _data?: { readonly uncompressedSize?: unknown };
};

async function loadBoundedOfficeZip(bytes: Uint8Array): Promise<JSZip> {
  if (bytes.byteLength > MAX_RICH_WORKPIECE_SOURCE_BYTES) {
    throw new Error("Office archive exceeds compressed size limit");
  }
  const zip = await JSZip.loadAsync(bytes);
  let decompressedBytes = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const size = (entry as SizedZipEntry)._data?.uncompressedSize;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("Office archive has invalid size metadata");
    }
    decompressedBytes += size;
    if (decompressedBytes > MAX_OFFICE_DECOMPRESSED_BYTES) {
      throw new Error("Office archive exceeds decompressed size limit");
    }
  }
  return zip;
}

function assertBoundedOfficeOutput(state: WorkpieceState): void {
  if (encoder.encode(JSON.stringify(state)).byteLength > MAX_WORKPIECE_STATE_BYTES) {
    throw new Error("Office import exceeds output size limit");
  }
}

function plainTextFromHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textForState(state: WorkpieceState): string {
  if ("text" in state) return state.text;
  if ("html" in state) return plainTextFromHtml(state.html);
  if ("csv" in state) return state.csv;
  if ("pdfText" in state) return state.pdfText;
  return state.slides
    .map((slide) => [slide.title, slide.body, slide.notes].filter(Boolean).join("\n"))
    .join("\n\n");
}

function splitMarkdownParagraphs(text: string): Paragraph[] {
  return text.split(/\n{2,}/).flatMap((block) => {
    const trimmed = block.trim();
    if (!trimmed) return [];
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const marker = heading[1] ?? "";
      const text = heading[2] ?? "";
      const level = marker.length === 1
        ? HeadingLevel.HEADING_1
        : marker.length === 2
        ? HeadingLevel.HEADING_2
        : HeadingLevel.HEADING_3;
      return [new Paragraph({ text, heading: level })];
    }
    return [new Paragraph({
      children: trimmed.split("\n").map((line, index) =>
        new TextRun({ text: index === 0 ? line : `\n${line}` })
      ),
    })];
  });
}

async function renderDocx(state: WorkpieceState): Promise<Uint8Array> {
  const text = textForState(state);
  const children = splitMarkdownParagraphs(text);
  const doc = new Document({
    sections: [{
      properties: {},
      children: children.length > 0 ? children : [new Paragraph("")],
    }],
  });
  return Packer.toBuffer(doc);
}

async function renderXlsx(state: WorkpieceState): Promise<Uint8Array> {
  const rows = parseCsv("csv" in state ? state.csv : textForState(state));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Skynet";
  const sheet = workbook.addWorksheet("Sheet 1");
  rows.forEach((row) => {
    sheet.addRow(row);
  });
  sheet.columns.forEach((column) => {
    const values = column.values ?? [];
    const width = Math.max(8, ...values.map((value) => String(value ?? "").length + 2));
    column.width = Math.min(width, 48);
  });
  const bytes = await workbook.xlsx.writeBuffer();
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

async function renderPptx(state: WorkpieceState): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  const slides = "slides" in state
    ? state.slides
    : [{ title: "Document", body: textForState(state) }];
  for (const item of slides.length > 0 ? slides : [{ title: "Untitled", body: "" }]) {
    const slide = pptx.addSlide();
    slide.background = { color: "111111" };
    slide.addText(item.title || "Untitled", {
      x: 0.7,
      y: 0.55,
      w: 11.9,
      h: 0.7,
      fontFace: "Arial",
      fontSize: 30,
      color: "FFFFFF",
      bold: true,
    });
    slide.addText(item.body || " ", {
      x: 0.75,
      y: 1.6,
      w: 11.6,
      h: 4.4,
      fontFace: "Arial",
      fontSize: 18,
      color: "D8D8D8",
      breakLine: false,
      fit: "shrink",
    });
    if (item.notes) slide.addNotes(item.notes);
  }
  const bytes = await pptx.write({ outputType: "nodebuffer" });
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
}

function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (`${line} ${word}`.trim().length > maxChars && line) {
        lines.push(line);
        line = word;
      } else {
        line = `${line} ${word}`.trim();
      }
    }
    lines.push(line);
  }
  return lines;
}

async function renderPdf(state: WorkpieceState): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const supportedCharacters = new Set(font.getCharacterSet());
  const boldSupportedCharacters = new Set(bold.getCharacterSet());
  const margin = 54;
  const lineHeight = 16;
  const lines = wrapText(textForState(state), 86);
  const unsupportedCharacters = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const characterSet = index === 0 ? boldSupportedCharacters : supportedCharacters;
    for (const character of line) {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined || !characterSet.has(codePoint)) {
        unsupportedCharacters.add(character);
      }
    }
  }
  if (unsupportedCharacters.size > 0) {
    throw new UnsupportedPdfUnicodeError([...unsupportedCharacters]);
  }

  let page = pdf.addPage([612, 792]);
  let y = page.getHeight() - margin;
  for (const [index, line] of lines.entries()) {
    if (y < margin) {
      page = pdf.addPage([612, 792]);
      y = page.getHeight() - margin;
    }
    page.drawText(line || " ", {
      x: margin,
      y,
      size: index === 0 ? 16 : 11,
      font: index === 0 ? bold : font,
      color: rgb(0.1, 0.1, 0.1),
      maxWidth: page.getWidth() - margin * 2,
    });
    y -= index === 0 ? lineHeight + 8 : lineHeight;
  }
  return pdf.save();
}

function renderCanonical(state: WorkpieceState, format: CanonicalArtifactFormat): FormatExport {
  if (format === "html") {
    const html = "html" in state
      ? state.html
      : `<p>${textForState(state).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("\n", "<br>")}</p>`;
    return { bytes: encoder.encode(html), contentType: "text/html; charset=utf-8", extension: "html" };
  }
  if (format === "csv") {
    return {
      bytes: encoder.encode("csv" in state ? state.csv : textForState(state)),
      contentType: "text/csv; charset=utf-8",
      extension: "csv",
    };
  }
  if (format === "json") {
    return {
      bytes: encoder.encode("slides" in state ? JSON.stringify({ slides: state.slides }, null, 2) : "{}"),
      contentType: "application/json; charset=utf-8",
      extension: "json",
    };
  }
  return {
    bytes: encoder.encode(textForState(state)),
    contentType: "text/plain; charset=utf-8",
    extension: "txt",
  };
}

async function renderNative(state: WorkpieceState, format: NativeArtifactFormat): Promise<FormatExport> {
  if (format === "docx") {
    return { bytes: await renderDocx(state), contentType: DOCX_CONTENT_TYPE, extension: "docx" };
  }
  if (format === "xlsx") {
    return { bytes: await renderXlsx(state), contentType: XLSX_CONTENT_TYPE, extension: "xlsx" };
  }
  if (format === "pptx") {
    return { bytes: await renderPptx(state), contentType: PPTX_CONTENT_TYPE, extension: "pptx" };
  }
  return { bytes: await renderPdf(state), contentType: PDF_CONTENT_TYPE, extension: "pdf" };
}

export async function renderArtifactExport(
  state: WorkpieceState,
  format: ArtifactExportFormat,
): Promise<FormatExport> {
  return format === "docx" || format === "xlsx" || format === "pptx" || format === "pdf"
    ? renderNative(state, format)
    : renderCanonical(state, format);
}

function xmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  await loadBoundedOfficeZip(bytes);
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  const text = result.value.trim();
  assertBoundedOfficeOutput({ text });
  return text;
}

export async function extractXlsxCsv(bytes: Uint8Array): Promise<string> {
  await loadBoundedOfficeZip(bytes);
  const workbook = new ExcelJS.Workbook();
  const buffer = Buffer.from(bytes);
  const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  await workbook.xlsx.load(data);
  const sheet = workbook.worksheets[0];
  if (!sheet) return "";
  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows.push(values.map((value) => String(value ?? "")));
  });
  const csv = serializeCsv(rows);
  assertBoundedOfficeOutput({ csv });
  return csv;
}

export async function extractPptxSlides(bytes: Uint8Array): Promise<PresentationSlide[]> {
  const zip = await loadBoundedOfficeZip(bytes);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const slides: PresentationSlide[] = [];
  for (const name of slideFiles) {
    const xml = await zip.file(name)?.async("string");
    if (!xml) continue;
    const texts = [...xml.matchAll(/<a:t[^>]*>(.*?)<\/a:t>/gs)]
      .map((match) => xmlText(match[1] ?? "").trim())
      .filter(Boolean);
    slides.push({
      title: texts[0] ?? "Slide",
      body: texts.slice(1).join("\n"),
    });
  }
  assertBoundedOfficeOutput({ slides });
  return slides;
}
