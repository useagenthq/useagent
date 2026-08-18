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
  columnLabel,
  DECK_REFERENCE_HEIGHT,
  deckToSlides,
  DOCX_CONTENT_TYPE,
  formatA1,
  MAX_RICH_WORKPIECE_SOURCE_BYTES,
  MAX_WORKPIECE_STATE_BYTES,
  parseA1,
  PDF_CONTENT_TYPE,
  parseArtifactCsv as parseCsv,
  PPTX_CONTENT_TYPE,
  resolveBlockColor,
  resolveSlideBackground,
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  WORKBOOK_MAX_SHEETS,
  workbookToCsv,
  XLSX_CONTENT_TYPE,
  type ArtifactPresentationSlide as PresentationSlide,
  type ArtifactWorkpieceState as WorkpieceState,
  type DeckBackground,
  type DeckBlock,
  type DeckSlide,
  type DeckTheme,
  type PresentationDeck,
  type SheetCell,
  type SheetCellFormat,
  type SheetNumberFormat,
  type Workbook,
  type Worksheet,
} from "@skynet/artifact-workspace";

/** The concrete slide object pptxgenjs hands back from `addSlide()`. */
type PptxSlide = ReturnType<InstanceType<typeof PptxGenJS>["addSlide"]>;

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

function assertBoundedOfficeOutput(state: unknown): void {
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
  if ("workbook" in state) return workbookToCsv(state.workbook);
  if ("pdfText" in state) return state.pdfText;
  // Presentation: flatten the deck to title/body/notes text for the non-native
  // canonical exports (docx/pdf/text/html) that a deck may be shared through.
  return deckToSlides(state.deck)
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

/** A hex color (`#rgb`/`#rrggbb`) to the 8-digit ARGB exceljs wants, or null. */
function argbColor(hex: string | undefined): string | null {
  if (!hex) return null;
  const raw = hex.replace(/^#/, "");
  const six = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw.slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(six) ? `FF${six.toUpperCase()}` : null;
}

/** Map a canonical number format to the Excel format code exceljs writes. */
function excelNumberFormat(numFmt: SheetNumberFormat | undefined): string | null {
  switch (numFmt) {
    case "currency":
      return '"$"#,##0.00';
    case "percent":
      return "0.##%";
    case "0":
      return "0";
    case "0.00":
      return "0.00";
    default:
      return null;
  }
}

/** Excel column width (in characters) approximated from a pixel width. */
function excelColumnWidth(px: number): number {
  return Math.max(2, Math.round(((px - 5) / 7) * 100) / 100);
}

function applyCellStyle(target: ExcelJS.Cell, fmt: SheetCellFormat): void {
  const fontColor = argbColor(fmt.color);
  if (fmt.bold || fmt.italic || fontColor) {
    target.font = {
      ...(fmt.bold ? { bold: true } : {}),
      ...(fmt.italic ? { italic: true } : {}),
      ...(fontColor ? { color: { argb: fontColor } } : {}),
    };
  }
  if (fmt.align) target.alignment = { horizontal: fmt.align };
  const fill = argbColor(fmt.fill);
  if (fill) {
    target.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  }
  const numFmt = excelNumberFormat(fmt.numFmt);
  if (numFmt) target.numFmt = numFmt;
}

function setCellValue(target: ExcelJS.Cell, cell: SheetCell): void {
  if (cell.f !== undefined) {
    // A real Excel formula (exceljs stores the formula without the leading =),
    // plus the cached result so a viewer that does not recompute still shows it.
    target.value = { formula: cell.f.replace(/^=/, ""), result: cell.v };
  } else {
    target.value = cell.v;
  }
  if (cell.fmt) applyCellStyle(target, cell.fmt);
}

function renderWorkbookXlsx(book: Workbook): Promise<Buffer | ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Skynet";
  for (const sheetModel of book.sheets) {
    const sheet = workbook.addWorksheet(sheetModel.name.slice(0, 31) || "Sheet");
    for (const [ref, cell] of Object.entries(sheetModel.cells)) {
      const position = parseA1(ref);
      if (!position) continue;
      setCellValue(sheet.getCell(position.row + 1, position.col + 1), cell);
    }
    for (const [label, px] of Object.entries(sheetModel.colWidths ?? {})) {
      sheet.getColumn(label).width = excelColumnWidth(px);
    }
  }
  return workbook.xlsx.writeBuffer();
}

async function renderXlsx(state: WorkpieceState): Promise<Uint8Array> {
  if ("workbook" in state) {
    const bytes = await renderWorkbookXlsx(state.workbook);
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }
  // A non-spreadsheet state exported to XLSX: one sheet of its flattened text.
  const rows = parseCsv(textForState(state));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Skynet";
  const sheet = workbook.addWorksheet("Sheet 1");
  rows.forEach((row) => {
    sheet.addRow(row);
  });
  const bytes = await workbook.xlsx.writeBuffer();
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

// The deck exports onto a 10 x 5.625in (16:9) slide, so a block's percent
// coordinates map to inches by a flat scale and its reference-px font size maps
// to points by the same ratio (5.625in = 405pt over the 1080-tall reference).
const PPTX_SLIDE_WIDTH_IN = 10;
const PPTX_SLIDE_HEIGHT_IN = 5.625;
const PPTX_PT_PER_REF_PX = 405 / DECK_REFERENCE_HEIGHT;

/** A hex color (with or without `#`, 3/4/6/8 digits) to the 6-digit RRGGBB
 * pptxgenjs wants, upper-cased. Falls back to the supplied default. */
function pptxColor(hex: string | undefined, fallback: string): string {
  const raw = (hex ?? "").replace(/^#/, "");
  const six = raw.length === 3
    ? [...raw].map((c) => c + c).join("")
    : raw.length >= 6
    ? raw.slice(0, 6)
    : raw.length === 4
    ? [...raw.slice(0, 3)].map((c) => c + c).join("")
    : "";
  return /^[0-9a-fA-F]{6}$/.test(six) ? six.toUpperCase() : fallback;
}

/** The solid fill color a background maps to in PPTX (gradients export as their
 * start color; images have no solid fill). */
function backgroundFillColor(background: DeckBackground): string | null {
  if (background.type === "color") return pptxColor(background.color, "111111");
  if (background.type === "gradient") return pptxColor(background.from, "111111");
  return null;
}

function applySlideBackground(
  slide: PptxSlide,
  background: DeckBackground,
): void {
  if (background.type === "image" && /^https?:\/\//.test(background.url)) {
    slide.background = { path: background.url };
    return;
  }
  slide.background = { color: backgroundFillColor(background) ?? "111111" };
}

function addDeckBlock(
  pptx: PptxGenJS,
  slide: PptxSlide,
  block: DeckBlock,
  theme: DeckTheme,
): void {
  const x = (block.x / 100) * PPTX_SLIDE_WIDTH_IN;
  const y = (block.y / 100) * PPTX_SLIDE_HEIGHT_IN;
  const w = (block.w / 100) * PPTX_SLIDE_WIDTH_IN;
  const h = (block.h / 100) * PPTX_SLIDE_HEIGHT_IN;

  if (block.type === "image") {
    // Only absolute-URL images can be fetched at export time; positioned assets
    // hosted at a relative path are left out (documented in the fidelity note).
    if (/^https?:\/\//.test(block.content)) {
      slide.addImage({ path: block.content, x, y, w, h });
    }
    return;
  }
  if (block.type === "shape") {
    const radiusIn = ((block.style?.radius ?? 0) / DECK_REFERENCE_HEIGHT) * PPTX_SLIDE_HEIGHT_IN;
    const shapeType = radiusIn > 0 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
    slide.addShape(shapeType, {
      x,
      y,
      w,
      h,
      fill: { color: pptxColor(block.style?.fill ?? theme.accent, "7AA2F7") },
      ...(radiusIn > 0 ? { rectRadius: radiusIn } : {}),
    });
    return;
  }
  slide.addText(block.content || " ", {
    x,
    y,
    w,
    h,
    fontFace: "Arial",
    fontSize: Math.max(1, Math.round((block.style?.fontSize ?? 40) * PPTX_PT_PER_REF_PX * 10) / 10),
    color: pptxColor(resolveBlockColor(block, theme).replace(/^#/, ""), "FFFFFF"),
    bold: block.style?.bold ?? block.type === "heading",
    italic: block.style?.italic ?? false,
    align: block.style?.align ?? "left",
    valign: "top",
    fit: "shrink",
  });
}

function renderDeckSlide(pptx: PptxGenJS, deck: PresentationDeck, deckSlide: DeckSlide): void {
  const slide = pptx.addSlide();
  applySlideBackground(slide, resolveSlideBackground(deck, deckSlide));
  for (const block of deckSlide.blocks) addDeckBlock(pptx, slide, block, deck.theme);
  if (deckSlide.notes) slide.addNotes(deckSlide.notes);
}

async function renderPptx(state: WorkpieceState): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "DECK", width: PPTX_SLIDE_WIDTH_IN, height: PPTX_SLIDE_HEIGHT_IN });
  pptx.layout = "DECK";

  if ("deck" in state) {
    const deck = state.deck;
    const slides = deck.slides.length > 0
      ? deck.slides
      : [{ id: "slide-1", blocks: [] }];
    for (const deckSlide of slides) renderDeckSlide(pptx, deck, deckSlide);
  } else {
    // A non-presentation state exported to PPTX: one dark title slide of its text.
    const slide = pptx.addSlide();
    slide.background = { color: "111111" };
    slide.addText(textForState(state) || " ", {
      x: 0.75,
      y: 0.75,
      w: 8.5,
      h: 4,
      fontFace: "Arial",
      fontSize: 18,
      color: "D8D8D8",
      fit: "shrink",
    });
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
      bytes: encoder.encode(textForState(state)),
      contentType: "text/csv; charset=utf-8",
      extension: "csv",
    };
  }
  if (format === "json") {
    return {
      bytes: encoder.encode("deck" in state ? JSON.stringify(state.deck, null, 2) : "{}"),
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


const IMPORT_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

function stripControl(value: string): string {
  return value.replace(IMPORT_CONTROL_CHARS, " ");
}

/** An exceljs ARGB (`FFRRGGBB`) or RGB hex to canonical `#rrggbb`, or undefined. */
function hexFromArgb(argb: unknown): string | undefined {
  if (typeof argb !== "string") return undefined;
  const six = argb.length === 8 ? argb.slice(2) : argb.length === 6 ? argb : "";
  return /^[0-9a-fA-F]{6}$/.test(six) ? `#${six.toLowerCase()}` : undefined;
}

/** Reverse-map an Excel number format code to our bounded canonical set. */
function importNumberFormat(code: string | undefined): SheetNumberFormat | undefined {
  if (!code || code === "General") return undefined;
  if (code.includes("%")) return "percent";
  if (code.includes("$") || code.includes("¤")) return "currency";
  if (code.includes("0.00")) return "0.00";
  if (code === "0" || code === "#,##0") return "0";
  return undefined;
}

function importCellFormat(cell: ExcelJS.Cell): SheetCellFormat | undefined {
  const fmt: {
    bold?: boolean;
    italic?: boolean;
    align?: SheetCellFormat["align"];
    numFmt?: SheetNumberFormat;
    fill?: string;
    color?: string;
  } = {};
  const font = cell.font;
  if (font?.bold) fmt.bold = true;
  if (font?.italic) fmt.italic = true;
  const color = hexFromArgb(font?.color?.argb);
  if (color) fmt.color = color;
  const align = cell.alignment?.horizontal;
  if (align === "left" || align === "center" || align === "right") fmt.align = align;
  const numFmt = importNumberFormat(cell.numFmt);
  if (numFmt) fmt.numFmt = numFmt;
  const rawFill = cell.fill as { pattern?: string; fgColor?: { argb?: string } } | undefined;
  const fill = rawFill?.pattern === "solid" ? hexFromArgb(rawFill.fgColor?.argb) : undefined;
  if (fill) fmt.fill = fill;
  return Object.keys(fmt).length > 0 ? fmt : undefined;
}

function importCellValue(cell: ExcelJS.Cell): { v: string | number; f?: string } | null {
  if (cell.type === ExcelJS.ValueType.Formula) {
    const formula = typeof cell.formula === "string" ? cell.formula : "";
    const result = cell.result;
    const v = typeof result === "number" && Number.isFinite(result)
      ? result
      : result == null
      ? ""
      : stripControl(String(result));
    return formula ? { v, f: `=${formula}` } : { v };
  }
  const value = cell.value;
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? { v: value } : null;
  if (typeof value === "boolean") return { v: value ? "TRUE" : "FALSE" };
  if (value instanceof Date) return { v: value.toISOString() };
  if (typeof value === "string") {
    const text = stripControl(value);
    return text ? { v: text } : null;
  }
  if (typeof value === "object") {
    const rich = value as { richText?: { text?: string }[]; text?: string; error?: string };
    if (Array.isArray(rich.richText)) {
      const text = stripControl(rich.richText.map((part) => part.text ?? "").join(""));
      return text ? { v: text } : null;
    }
    if (typeof rich.text === "string") {
      const text = stripControl(rich.text);
      return text ? { v: text } : null;
    }
    if (typeof rich.error === "string") return { v: stripControl(rich.error) };
  }
  return null;
}

function importWorksheet(sheet: ExcelJS.Worksheet, index: number): Worksheet {
  const cells: Record<string, SheetCell> = {};
  let maxRow = 0;
  let maxCol = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > SHEET_MAX_ROWS) return;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (colNumber > SHEET_MAX_COLS) return;
      const parsed = importCellValue(cell);
      if (!parsed) return;
      const fmt = importCellFormat(cell);
      cells[formatA1(rowNumber - 1, colNumber - 1)] = { ...parsed, ...(fmt ? { fmt } : {}) };
      if (rowNumber - 1 > maxRow) maxRow = rowNumber - 1;
      if (colNumber - 1 > maxCol) maxCol = colNumber - 1;
    });
  });
  const colWidths: Record<string, number> = {};
  sheet.columns?.forEach((column, columnIndex) => {
    if (columnIndex > maxCol || typeof column.width !== "number") return;
    colWidths[columnLabel(columnIndex)] = Math.round(column.width * 7 + 5);
  });
  return {
    id: `sheet-${index + 1}`,
    name: stripControl(sheet.name).slice(0, 128) || `Sheet ${index + 1}`,
    cells,
    rowCount: Math.max(1, Math.min(SHEET_MAX_ROWS, maxRow + 1)),
    colCount: Math.max(1, Math.min(SHEET_MAX_COLS, maxCol + 1)),
    ...(Object.keys(colWidths).length > 0 ? { colWidths } : {}),
  };
}

/** Import an uploaded XLSX into a canonical v2 workbook: every worksheet, cell
 * values, formulas in cells (exceljs preserves the formula string), number
 * formats, bold/italic/align, text/fill colors, and column widths. Charts,
 * pivots, and conditional formatting are dropped (the documented import edge).
 * The result is still funnelled through the shared validator by the caller. */
export async function extractXlsxWorkbook(bytes: Uint8Array): Promise<Workbook> {
  await loadBoundedOfficeZip(bytes);
  const workbook = new ExcelJS.Workbook();
  const buffer = Buffer.from(bytes);
  const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  await workbook.xlsx.load(data);
  const sheets = workbook.worksheets
    .slice(0, WORKBOOK_MAX_SHEETS)
    .map((sheet, index) => importWorksheet(sheet, index));
  if (sheets.length === 0) {
    sheets.push({ id: "sheet-1", name: "Sheet 1", cells: {}, rowCount: 1, colCount: 1 });
  }
  const result: Workbook = { schemaVersion: 2, sheets, activeSheetId: sheets[0]!.id };
  assertBoundedOfficeOutput(result);
  return result;
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
