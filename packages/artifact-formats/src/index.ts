import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
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

const ORDERED_LIST_REFERENCE = "skynet-ordered-list";
const INLINE_HTML_TAGS = new Set(["a", "b", "br", "em", "i", "span", "strong", "u"]);
const MAX_HTML_NESTING = 8;

interface HtmlElement {
  readonly type: "element";
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: HtmlNode[];
}
interface HtmlText {
  readonly type: "text";
  readonly value: string;
}
type HtmlNode = HtmlElement | HtmlText;
interface InlineFormat {
  readonly bold?: boolean;
  readonly italics?: boolean;
  readonly underline?: boolean;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;/gi, "'")
    .replace(/&#(\d{1,7});/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function parseHtmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const name = match[1]?.toLowerCase();
    if (name) attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

/** Parse the deliberately small, pre-validated rich-HTML subset into a node
 * tree. The stored state has already passed `normalizeArtifactRichHtml`, so the
 * markup is well-formed and limited to the safe tag/attribute set. */
function parseHtmlSubset(html: string): HtmlNode[] {
  const root: HtmlElement = { type: "element", tag: "#root", attributes: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const tokens = /<(\/?)([a-z0-9]+)([^>]*?)(\/?)>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  const pushText = (text: string) => {
    if (text) stack[stack.length - 1]?.children.push({ type: "text", value: text });
  };
  while ((match = tokens.exec(html))) {
    pushText(html.slice(cursor, match.index));
    cursor = tokens.lastIndex;
    const closing = match[1] === "/";
    const tag = (match[2] ?? "").toLowerCase();
    const selfClosing = match[4] === "/" || tag === "br";
    if (closing) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index]?.tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const element: HtmlElement = {
      type: "element",
      tag,
      attributes: parseHtmlAttributes(match[3] ?? ""),
      children: [],
    };
    stack[stack.length - 1]?.children.push(element);
    if (!selfClosing && stack.length < MAX_HTML_NESTING) stack.push(element);
  }
  pushText(html.slice(cursor));
  return root.children;
}

function inlineNodesToRuns(
  nodes: readonly HtmlNode[],
  format: InlineFormat = {},
): (TextRun | ExternalHyperlink)[] {
  const runs: (TextRun | ExternalHyperlink)[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const text = decodeHtmlEntities(node.value).replace(/\s+/g, " ");
      if (text) {
        runs.push(new TextRun({
          text,
          bold: format.bold,
          italics: format.italics,
          underline: format.underline ? {} : undefined,
        }));
      }
      continue;
    }
    if (node.tag === "br") {
      runs.push(new TextRun({ text: "", break: 1 }));
      continue;
    }
    if (node.tag === "a") {
      const link = node.attributes.href;
      const children = inlineNodesToRuns(node.children, { ...format, underline: true })
        .filter((run): run is TextRun => run instanceof TextRun);
      if (link) {
        runs.push(new ExternalHyperlink({ children, link }));
      } else {
        runs.push(...children);
      }
      continue;
    }
    const nextFormat: InlineFormat = {
      bold: format.bold || node.tag === "strong" || node.tag === "b",
      italics: format.italics || node.tag === "em" || node.tag === "i",
      underline: format.underline || node.tag === "u",
    };
    runs.push(...inlineNodesToRuns(node.children, nextFormat));
  }
  return runs;
}

function listItemsToParagraphs(list: HtmlElement, ordered: boolean, level: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  for (const item of list.children) {
    if (item.type !== "element" || item.tag !== "li") continue;
    const nestedLists = item.children.filter(
      (child): child is HtmlElement =>
        child.type === "element" && (child.tag === "ul" || child.tag === "ol"),
    );
    const inline = item.children.filter((child) => !nestedLists.includes(child as HtmlElement));
    paragraphs.push(new Paragraph({
      children: inlineNodesToRuns(inline),
      ...(ordered
        ? { numbering: { reference: ORDERED_LIST_REFERENCE, level: Math.min(level, 2) } }
        : { bullet: { level: Math.min(level, 2) } }),
    }));
    for (const nested of nestedLists) {
      paragraphs.push(...listItemsToParagraphs(nested, nested.tag === "ol", level + 1));
    }
  }
  return paragraphs;
}

function tableRowsFrom(node: HtmlElement): HtmlElement[] {
  const rows: HtmlElement[] = [];
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tag === "tr") rows.push(child);
    else if (child.tag === "thead" || child.tag === "tbody") rows.push(...tableRowsFrom(child));
  }
  return rows;
}

function tableToDocx(node: HtmlElement): Table | null {
  const rows = tableRowsFrom(node)
    .map((row) =>
      row.children.filter(
        (cell): cell is HtmlElement =>
          cell.type === "element" && (cell.tag === "td" || cell.tag === "th"),
      )
    )
    .filter((cells) => cells.length > 0)
    .map((cells) =>
      new TableRow({
        children: cells.map((cell) => {
          const runs = inlineNodesToRuns(cell.children, cell.tag === "th" ? { bold: true } : {});
          const columnSpan = Number(cell.attributes.colspan);
          const rowSpan = Number(cell.attributes.rowspan);
          return new TableCell({
            children: [new Paragraph({ children: runs })],
            columnSpan: Number.isInteger(columnSpan) && columnSpan > 1 ? columnSpan : undefined,
            rowSpan: Number.isInteger(rowSpan) && rowSpan > 1 ? rowSpan : undefined,
          });
        }),
      })
    );
  return rows.length > 0
    ? new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })
    : null;
}

function headingLevelFor(tag: string) {
  return tag === "h1"
    ? HeadingLevel.HEADING_1
    : tag === "h2"
    ? HeadingLevel.HEADING_2
    : HeadingLevel.HEADING_3;
}

/** Map the rich-HTML document companion into real DOCX structure (headings,
 * bold/italic/underline runs, ordered and bulleted lists, hyperlinks, tables)
 * so exporting an edited document to Word preserves its formatting instead of
 * flattening everything to plain text. */
function richHtmlToDocxChildren(html: string): (Paragraph | Table)[] {
  const nodes = parseHtmlSubset(html);
  const children: (Paragraph | Table)[] = [];
  let inlineBuffer: HtmlNode[] = [];
  const flushInline = () => {
    if (inlineBuffer.length === 0) return;
    const runs = inlineNodesToRuns(inlineBuffer);
    inlineBuffer = [];
    if (runs.length > 0) children.push(new Paragraph({ children: runs }));
  };
  for (const node of nodes) {
    if (node.type === "text" || INLINE_HTML_TAGS.has(node.tag)) {
      inlineBuffer.push(node);
      continue;
    }
    flushInline();
    if (node.tag === "h1" || node.tag === "h2" || node.tag === "h3") {
      children.push(new Paragraph({
        heading: headingLevelFor(node.tag),
        children: inlineNodesToRuns(node.children),
      }));
    } else if (node.tag === "ul" || node.tag === "ol") {
      children.push(...listItemsToParagraphs(node, node.tag === "ol", 0));
    } else if (node.tag === "table") {
      const table = tableToDocx(node);
      if (table) children.push(table);
    } else {
      // p, div, and any other block wrapper: render its content as a paragraph.
      children.push(new Paragraph({ children: inlineNodesToRuns(node.children) }));
    }
  }
  flushInline();
  return children;
}

async function renderDocx(state: WorkpieceState): Promise<Uint8Array> {
  const children = "html" in state
    ? richHtmlToDocxChildren(state.html)
    : splitMarkdownParagraphs(textForState(state));
  const doc = new Document({
    numbering: {
      config: [{
        reference: ORDERED_LIST_REFERENCE,
        levels: [0, 1, 2].map((level) => ({
          level,
          format: LevelFormat.DECIMAL,
          text: `%${level + 1}.`,
          alignment: AlignmentType.LEFT,
        })),
      }],
    },
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

/** A structural, content-agnostic page operation over an existing PDF. Reorder
 * takes a full permutation of the current page indices; delete removes a set of
 * pages. Neither reads or rewrites the text or drawing inside a page, so page
 * structure is preserved even on PDFs Skynet did not author. */
export type PdfPageOperation =
  | Readonly<{ type: "reorder"; order: readonly number[] }>
  | Readonly<{ type: "delete"; pages: readonly number[] }>;

export class PdfPageOperationError extends Error {
  readonly code = "PDF_PAGE_OPERATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PdfPageOperationError";
  }
}

async function loadPdfForPageOps(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes);
  } catch {
    throw new PdfPageOperationError("input is not a readable PDF");
  }
}

export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  return (await loadPdfForPageOps(bytes)).getPageCount();
}

function resolvedPageOrder(operation: PdfPageOperation, pageCount: number): number[] {
  const inRange = (index: number) => Number.isInteger(index) && index >= 0 && index < pageCount;
  if (operation.type === "reorder") {
    if (operation.order.length !== pageCount) {
      throw new PdfPageOperationError(`reorder needs exactly ${pageCount} page indices`);
    }
    const seen = new Set<number>();
    for (const index of operation.order) {
      if (!inRange(index)) throw new PdfPageOperationError(`page index ${index} is out of range`);
      if (seen.has(index)) throw new PdfPageOperationError(`page index ${index} is duplicated`);
      seen.add(index);
    }
    return [...operation.order];
  }
  if (operation.pages.length === 0) {
    throw new PdfPageOperationError("delete needs at least one page index");
  }
  const removed = new Set<number>();
  for (const index of operation.pages) {
    if (!inRange(index)) throw new PdfPageOperationError(`page index ${index} is out of range`);
    removed.add(index);
  }
  const kept = Array.from({ length: pageCount }, (_, index) => index).filter(
    (index) => !removed.has(index),
  );
  if (kept.length === 0) throw new PdfPageOperationError("cannot delete every page");
  return kept;
}

/** Apply a page reorder or delete to PDF bytes, returning fresh PDF bytes with
 * the surviving pages copied in the requested order. Pure: same input bytes and
 * operation always yield the same structure, and the source bytes are untouched. */
export async function applyPdfPageOperation(
  bytes: Uint8Array,
  operation: PdfPageOperation,
): Promise<Uint8Array> {
  const source = await loadPdfForPageOps(bytes);
  const order = resolvedPageOrder(operation, source.getPageCount());
  const output = await PDFDocument.create();
  const pages = await output.copyPages(source, order);
  for (const page of pages) output.addPage(page);
  return output.save();
}

export const ARTIFACT_BUNDLE_CONTENT_TYPE = "application/zip";

export interface ArtifactBundleEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

function sanitizeBundleName(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").pop() ?? "";
  const cleaned = [...base]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "artifact";
}
function uniqueBundleName(used: Map<string, number>, name: string): string {
  const base = sanitizeBundleName(name);
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  if (seen === 0) return base;
  const dot = base.lastIndexOf(".");
  const suffix = ` (${seen + 1})`;
  return dot > 0 ? `${base.slice(0, dot)}${suffix}${base.slice(dot)}` : `${base}${suffix}`;
}

/** Package multiple artifacts' bytes into one ZIP. Colliding filenames are
 * disambiguated with a numeric suffix so every entry survives the bundle. */
export async function buildArtifactBundle(
  entries: readonly ArtifactBundleEntry[],
): Promise<FormatExport> {
  const zip = new JSZip();
  const used = new Map<string, number>();
  for (const entry of entries) {
    zip.file(uniqueBundleName(used, entry.name), entry.bytes);
  }
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return { bytes, contentType: ARTIFACT_BUNDLE_CONTENT_TYPE, extension: "zip" };
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
