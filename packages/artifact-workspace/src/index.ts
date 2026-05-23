import {
  ARTIFACT_AUTHORING_ACTIONS,
  DOCX_CONTENT_TYPE,
  MAX_RICH_WORKPIECE_SOURCE_BYTES,
  PDF_CONTENT_TYPE,
  PPTX_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  type ArtifactDescriptor,
  type ArtifactAction,
  type ArtifactAuthoringAction,
  type ArtifactWorkpieceExport,
  type ArtifactWorkpieceKind,
  type ArtifactWorkpieceState,
} from "./contracts";
import { coerceDocumentState, normalizeDocument } from "./document";
import { migrateSlidesToDeck, normalizeDeck } from "./presentation";
import { csvToWorkbook, normalizeWorkbook } from "./spreadsheet";

export * from "./contracts";
export * from "./csv";
export * from "./document";
export * from "./formula";
export * from "./presentation";
export * from "./rich-html";
export * from "./spreadsheet";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv; charset=utf-8",
  ".docx": DOCX_CONTENT_TYPE,
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mp4": "video/mp4",
  ".pdf": PDF_CONTENT_TYPE,
  ".png": "image/png",
  ".pptx": PPTX_CONTENT_TYPE,
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xlsx": XLSX_CONTENT_TYPE,
};

const INLINE_PREVIEW_CONTENT_TYPES = new Set([
  "application/json",
  PDF_CONTENT_TYPE,
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
  "video/mp4",
  "video/webm",
]);

const DOCUMENT_EXTENSIONS = new Set(["json", "markdown", "md", "txt", "xml", "yaml", "yml"]);
const SURFACE_DOCUMENT_EXTENSIONS = new Set([
  "csv",
  "docx",
  "json",
  "md",
  "pdf",
  "pptx",
  "txt",
  "xlsx",
]);

const DOCUMENT_CONTENT_TYPES = new Set([
  "application/json",
  "application/xml",
  DOCX_CONTENT_TYPE,
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/x-markdown",
]);

export type ArtifactWorkspaceKind =
  | "document"
  | "spreadsheet"
  | "presentation"
  | "pdf"
  | "media"
  | "html"
  | "svg"
  | "binary";

export type ArtifactSurfaceCategory = "files" | "docs" | "media";
export type ArtifactPreviewRenderer = "image" | "video" | "pdf" | "text";

export type ArtifactEditContract =
  | Readonly<{
    mode: "direct";
    state: "text" | "csv" | "slides" | "pdfText";
    kind: ArtifactWorkpieceKind;
  }>
  | Readonly<{
    mode: "companion";
    state: "html" | "csv" | "slides" | "pdfText";
    kind: ArtifactWorkpieceKind;
    companionExtension: "html" | "csv" | "json" | "txt";
    maxSourceBytes: number;
  }>;

export interface ArtifactCapabilities {
  readonly kind: ArtifactWorkspaceKind;
  readonly preview: Readonly<{
    inline: boolean;
    renderer: ArtifactPreviewRenderer | null;
  }>;
  readonly edit: ArtifactEditContract | null;
  readonly actions: readonly ArtifactAction[];
}

export interface ArtifactAuthoringProfile<
  Kind extends ArtifactWorkpieceKind = ArtifactWorkpieceKind,
> {
  readonly kind: Kind;
  readonly label: string;
  readonly description: string;
  readonly defaultName: string;
  readonly companion: Readonly<{
    extension: "html" | "csv" | "json" | "txt";
    contentType: string;
  }>;
  readonly exports: readonly ArtifactWorkpieceExport[];
  readonly actions: readonly ArtifactAuthoringAction[];
  readonly defaultState: (name: string) => ArtifactWorkpieceState<Kind>;
}

const DOCUMENT_EXPORTS = [
  {
    format: "docx",
    label: "Microsoft Word document",
    extension: "docx",
    content_type: DOCX_CONTENT_TYPE,
    native: true,
  },
  {
    format: "html",
    label: "Canonical HTML",
    extension: "html",
    content_type: "text/html; charset=utf-8",
    native: false,
  },
  {
    format: "text",
    label: "Canonical text",
    extension: "txt",
    content_type: "text/plain; charset=utf-8",
    native: false,
  },
] as const satisfies readonly ArtifactWorkpieceExport[];

const SPREADSHEET_EXPORTS = [
  {
    format: "xlsx",
    label: "Microsoft Excel workbook",
    extension: "xlsx",
    content_type: XLSX_CONTENT_TYPE,
    native: true,
  },
  {
    format: "csv",
    label: "Canonical CSV",
    extension: "csv",
    content_type: "text/csv; charset=utf-8",
    native: false,
  },
] as const satisfies readonly ArtifactWorkpieceExport[];

const PRESENTATION_EXPORTS = [
  {
    format: "pptx",
    label: "Microsoft PowerPoint deck",
    extension: "pptx",
    content_type: PPTX_CONTENT_TYPE,
    native: true,
  },
  {
    format: "json",
    label: "Canonical slide JSON",
    extension: "json",
    content_type: "application/json; charset=utf-8",
    native: false,
  },
] as const satisfies readonly ArtifactWorkpieceExport[];

const PDF_EXPORTS = [
  {
    format: "pdf",
    label: "PDF document",
    extension: "pdf",
    content_type: PDF_CONTENT_TYPE,
    native: true,
  },
  {
    format: "text",
    label: "Canonical PDF text",
    extension: "txt",
    content_type: "text/plain; charset=utf-8",
    native: false,
  },
] as const satisfies readonly ArtifactWorkpieceExport[];

function artifactNameStem(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "artifact";
}

const AUTHORING_PROFILE_BY_KIND = {
  document: {
    kind: "document",
    label: "Document",
    description: "Author a DOCX document with HTML and text companion exports.",
    defaultName: "Untitled document.docx",
    companion: { extension: "html", contentType: "text/html; charset=utf-8" },
    exports: DOCUMENT_EXPORTS,
    actions: ARTIFACT_AUTHORING_ACTIONS,
    defaultState: (name: string) => ({ text: `# ${artifactNameStem(name)}\n` }),
  },
  spreadsheet: {
    kind: "spreadsheet",
    label: "Spreadsheet",
    description: "Author an XLSX spreadsheet with a CSV companion export.",
    defaultName: "Untitled spreadsheet.xlsx",
    companion: { extension: "csv", contentType: "text/csv; charset=utf-8" },
    exports: SPREADSHEET_EXPORTS,
    actions: ARTIFACT_AUTHORING_ACTIONS,
    defaultState: (_name: string) => ({ workbook: csvToWorkbook("Name,Value\n") }),
  },
  presentation: {
    kind: "presentation",
    label: "Presentation",
    description: "Author a PPTX presentation with a JSON companion export.",
    defaultName: "Untitled presentation.pptx",
    companion: { extension: "json", contentType: "application/json; charset=utf-8" },
    exports: PRESENTATION_EXPORTS,
    actions: ARTIFACT_AUTHORING_ACTIONS,
    defaultState: (name: string) => ({
      deck: migrateSlidesToDeck([{ title: artifactNameStem(name), body: "", notes: "" }]),
    }),
  },
  pdf: {
    kind: "pdf",
    label: "PDF",
    description: "Author a PDF document with a text companion export.",
    defaultName: "Untitled PDF.pdf",
    companion: { extension: "txt", contentType: "text/plain; charset=utf-8" },
    exports: PDF_EXPORTS,
    actions: ARTIFACT_AUTHORING_ACTIONS,
    defaultState: (name: string) => ({ pdfText: `${artifactNameStem(name)}\n` }),
  },
} as const satisfies {
  readonly [Kind in ArtifactWorkpieceKind]: ArtifactAuthoringProfile<Kind>;
};

export const ARTIFACT_AUTHORING_PROFILES = [
  AUTHORING_PROFILE_BY_KIND.document,
  AUTHORING_PROFILE_BY_KIND.spreadsheet,
  AUTHORING_PROFILE_BY_KIND.presentation,
  AUTHORING_PROFILE_BY_KIND.pdf,
] as const satisfies readonly ArtifactAuthoringProfile[];

export function artifactAuthoringProfile<Kind extends ArtifactWorkpieceKind>(
  kind: Kind,
): (typeof AUTHORING_PROFILE_BY_KIND)[Kind] {
  return AUTHORING_PROFILE_BY_KIND[kind];
}

export function defaultArtifactWorkpieceState<Kind extends ArtifactWorkpieceKind>(
  kind: Kind,
  name: string,
): ArtifactWorkpieceState<Kind> {
  return artifactAuthoringProfile(kind).defaultState(name) as ArtifactWorkpieceState<Kind>;
}

export function normalizeArtifactContentType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function artifactFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function artifactExtensionLabel(name: string): string {
  return artifactFileExtension(name).toUpperCase() || "FILE";
}

export function contentTypeForName(name: string): string {
  const extension = artifactFileExtension(name);
  return CONTENT_TYPES[extension ? `.${extension}` : ""] ?? "application/octet-stream";
}

/** HTML and SVG are deliberately attachment-only because they are active content
 * on the application's origin. */
export function canPreviewInline(contentType: string): boolean {
  return INLINE_PREVIEW_CONTENT_TYPES.has(normalizeArtifactContentType(contentType));
}

function artifactPreviewFor(contentType: string): ArtifactCapabilities["preview"] {
  const mime = normalizeArtifactContentType(contentType);
  if (!INLINE_PREVIEW_CONTENT_TYPES.has(mime)) return { inline: false, renderer: null };
  if (["image/gif", "image/jpeg", "image/png", "image/webp"].includes(mime)) {
    return { inline: true, renderer: "image" };
  }
  if (mime.startsWith("video/")) return { inline: true, renderer: "video" };
  if (mime === PDF_CONTENT_TYPE) return { inline: true, renderer: "pdf" };
  return { inline: true, renderer: "text" };
}

function baseArtifactActions(
  preview: ArtifactCapabilities["preview"],
): readonly ArtifactAction[] {
  return preview.inline ? ["preview", "download"] : ["download"];
}

function artifactCapabilities(
  kind: ArtifactWorkspaceKind,
  preview: ArtifactCapabilities["preview"],
  edit: ArtifactEditContract | null,
): ArtifactCapabilities {
  return {
    kind,
    preview,
    edit,
    actions: baseArtifactActions(preview),
  };
}

function isArtifactFormat(
  artifact: Pick<ArtifactDescriptor, "content_type" | "name">,
  contentType: string,
  extension: string,
): boolean {
  return normalizeArtifactContentType(artifact.content_type) === contentType ||
    artifactFileExtension(artifact.name) === extension;
}

export function inferWorkpieceKind(
  name: string,
  contentType: string,
  sizeBytes = 0,
): ArtifactWorkpieceKind | null {
  const mime = normalizeArtifactContentType(contentType);
  const suffix = artifactFileExtension(name);
  const isOfficeDocument = mime === DOCX_CONTENT_TYPE || suffix === "docx";
  const isOfficeSpreadsheet = mime === XLSX_CONTENT_TYPE || suffix === "xlsx";
  const isOfficePresentation = mime === PPTX_CONTENT_TYPE || suffix === "pptx";
  const isPdf = mime === PDF_CONTENT_TYPE || suffix === "pdf";
  if (
    sizeBytes > MAX_RICH_WORKPIECE_SOURCE_BYTES &&
    (isOfficeDocument || isOfficeSpreadsheet || isOfficePresentation || isPdf)
  ) {
    return null;
  }
  if (isOfficeSpreadsheet || mime === "text/csv" || suffix === "csv") return "spreadsheet";
  if (isOfficePresentation) return "presentation";
  if (isPdf) return "pdf";
  return DOCUMENT_CONTENT_TYPES.has(mime) || DOCUMENT_EXTENSIONS.has(suffix) ? "document" : null;
}

export function artifactCapabilitiesFor(
  artifact: Pick<ArtifactDescriptor, "content_type" | "name" | "size_bytes">,
): ArtifactCapabilities {
  const mime = normalizeArtifactContentType(artifact.content_type);
  const suffix = artifactFileExtension(artifact.name);
  const preview = artifactPreviewFor(artifact.content_type);

  if (isArtifactFormat(artifact, DOCX_CONTENT_TYPE, "docx")) {
    return artifactCapabilities(
      "document",
      preview,
      artifact.size_bytes > MAX_RICH_WORKPIECE_SOURCE_BYTES
        ? null
        : {
          mode: "companion",
          kind: "document",
          state: "html",
          companionExtension: "html",
          maxSourceBytes: MAX_RICH_WORKPIECE_SOURCE_BYTES,
        },
    );
  }

  if (isArtifactFormat(artifact, XLSX_CONTENT_TYPE, "xlsx")) {
    return artifactCapabilities(
      "spreadsheet",
      preview,
      artifact.size_bytes > MAX_RICH_WORKPIECE_SOURCE_BYTES
        ? null
        : {
          mode: "companion",
          kind: "spreadsheet",
          state: "csv",
          companionExtension: "csv",
          maxSourceBytes: MAX_RICH_WORKPIECE_SOURCE_BYTES,
        },
    );
  }

  if (mime === "text/csv" || suffix === "csv") {
    return artifactCapabilities(
      "spreadsheet",
      preview,
      { mode: "direct", kind: "spreadsheet", state: "csv" },
    );
  }

  if (mime === PPTX_CONTENT_TYPE || suffix === "pptx") {
    return artifactCapabilities(
      "presentation",
      preview,
      artifact.size_bytes > MAX_RICH_WORKPIECE_SOURCE_BYTES
        ? null
        : {
          mode: "companion",
          kind: "presentation",
          state: "slides",
          companionExtension: "json",
          maxSourceBytes: MAX_RICH_WORKPIECE_SOURCE_BYTES,
        },
    );
  }

  if (mime === PDF_CONTENT_TYPE || suffix === "pdf") {
    return artifactCapabilities(
      "pdf",
      preview,
      artifact.size_bytes > MAX_RICH_WORKPIECE_SOURCE_BYTES
        ? null
        : {
          mode: "companion",
          kind: "pdf",
          state: "pdfText",
          companionExtension: "txt",
          maxSourceBytes: MAX_RICH_WORKPIECE_SOURCE_BYTES,
        },
    );
  }

  if (mime === "text/html" || suffix === "html") {
    return artifactCapabilities("html", preview, null);
  }

  if (mime === "image/svg+xml" || suffix === "svg") {
    return artifactCapabilities("svg", preview, null);
  }

  if (mime.startsWith("image/") || mime.startsWith("video/")) {
    return artifactCapabilities("media", preview, null);
  }

  if (DOCUMENT_CONTENT_TYPES.has(mime) || DOCUMENT_EXTENSIONS.has(suffix)) {
    return artifactCapabilities(
      "document",
      preview,
      { mode: "direct", kind: "document", state: "text" },
    );
  }

  return artifactCapabilities("binary", preview, null);
}

export function artifactActionContractFor(
  artifact: Pick<ArtifactDescriptor, "content_type" | "name" | "size_bytes"> &
    Readonly<{
      workpiece: Pick<
        NonNullable<ArtifactDescriptor["workpiece"]>,
        "kind" | "actions" | "export_url" | "exports"
      > | null;
    }>,
): ArtifactCapabilities {
  const capabilities = artifactCapabilitiesFor(artifact);
  const workpiece = artifact.workpiece;
  const editable = !!(
    capabilities.edit &&
    workpiece?.kind === capabilities.edit.kind &&
    workpiece.actions.includes("edit")
  );
  const exportable = !!(
    editable &&
    workpiece?.export_url &&
    workpiece.exports?.length
  );
  return {
    ...capabilities,
    edit: editable ? capabilities.edit : null,
    actions: [
      ...capabilities.actions,
      ...(editable ? ["edit" as const] : []),
      ...(exportable ? ["export" as const] : []),
    ],
  };
}

export function artifactWorkpieceExports(kind: ArtifactWorkpieceKind): readonly ArtifactWorkpieceExport[] {
  return artifactAuthoringProfile(kind).exports;
}

/** How a native upload of this kind becomes editable browser state:
 *  - `companion`: a bounded text/CSV/slide-JSON projection is imported (not a
 *    rich binary round-trip);
 *  - `authored`: state is authored in the browser and rendered to native bytes;
 *  - `unsupported`: the original stays download-only (no tested importer yet). */
export type ArtifactImportSupport = "companion" | "authored" | "unsupported";

/** The single source of truth for how honest each workpiece kind's editing is.
 * Both the product UI and the public API render these exact strings so a user is
 * never told a canonical companion is a rich binary round-trip. */
export interface ArtifactFidelity {
  readonly kind: ArtifactWorkpieceKind;
  /** One-line, plain-language description of what the editor actually edits. */
  readonly summary: string;
  /** Aspects the canonical edit round-trips into the native export. */
  readonly preserved: readonly string[];
  /** Aspects the canonical edit deliberately drops (stated, never hidden). */
  readonly notPreserved: readonly string[];
  readonly uploadImport: ArtifactImportSupport;
  /** Honest note shown wherever import is offered or withheld. */
  readonly importNote: string;
}

const ARTIFACT_FIDELITY_BY_KIND = {
  document: {
    kind: "document",
    summary:
      "Rich text with a document theme: headings, emphasis, lists, links, simple tables, and heading/body/background colors.",
    preserved: [
      "Headings (H1-H3)",
      "Bold, italic, and underline",
      "Bulleted and numbered lists",
      "Hyperlinks",
      "Tables with basic row and column spans",
      "Document theme heading and body text colors",
      "A solid page background color",
    ],
    notPreserved: [
      "Images and drawings",
      "Page layout, headers and footers, and columns",
      "Gradient and image page backgrounds (a gradient exports as its start color; an image background is dropped)",
      "The theme accent color (used in the browser view only)",
      "Font families and sizes",
      "Comments and tracked changes",
    ],
    uploadImport: "companion",
    importNote:
      "Uploaded Word files import as editable text; the original formatting is not reconstructed.",
  },
  spreadsheet: {
    kind: "spreadsheet",
    summary:
      "A web-native workbook: multiple sheets of A1-keyed cells with formulas, number formats, and basic styling.",
    preserved: [
      "Cell text and numbers",
      "Formulas in the supported set (arithmetic, cell refs, ranges, SUM, AVG, MIN, MAX, COUNT, IF, cross-sheet refs)",
      "Multiple worksheets",
      "Number formats (currency, percent, decimals)",
      "Bold, italic, alignment, text color, and cell fill",
      "Per-column widths",
    ],
    notPreserved: [
      "VLOOKUP and other functions beyond the supported set",
      "Charts, pivot tables, and images",
      "Conditional formatting and data validation",
      "Merged cells and cell comments",
    ],
    uploadImport: "companion",
    importNote:
      "Uploaded Excel files import cell values, formulas in the supported set, and basic formats across sheets; charts, pivots, and conditional formatting are dropped.",
  },
  presentation: {
    kind: "presentation",
    summary:
      "A web-native deck: positioned heading, text, and image blocks on a 16:9 canvas with a deck theme.",
    preserved: [
      "Positioned heading, text, and image blocks",
      "Deck theme (background, heading, body, and accent colors)",
      "Per-slide background overrides",
      "Speaker notes",
      "Slide order",
    ],
    notPreserved: [
      "Animations and transitions",
      "Charts and tables",
      "Shapes beyond rectangles",
      "Embedded fonts and master slides",
    ],
    uploadImport: "companion",
    importNote:
      "Uploaded PowerPoint files import slide text only; it becomes editable heading and text blocks.",
  },
  pdf: {
    kind: "pdf",
    summary: "Plain text rendered to a fresh PDF, plus page reorder and delete on published PDFs.",
    preserved: [
      "Body text",
      "Automatic line wrapping and pagination",
      "Reordering and deleting whole pages of a published PDF (page structure)",
    ],
    notPreserved: [
      "The original page layout, fonts, and images",
      "Tables, columns, and form fields",
      "Non-Latin scripts without an embedded font",
      "Editing the text or visual content inside an uploaded or published PDF page",
    ],
    uploadImport: "unsupported",
    importNote:
      "Uploaded PDFs cannot be imported for editing yet; the original stays downloadable.",
  },
} as const satisfies { readonly [Kind in ArtifactWorkpieceKind]: ArtifactFidelity };

export const ARTIFACT_FIDELITY = [
  ARTIFACT_FIDELITY_BY_KIND.document,
  ARTIFACT_FIDELITY_BY_KIND.spreadsheet,
  ARTIFACT_FIDELITY_BY_KIND.presentation,
  ARTIFACT_FIDELITY_BY_KIND.pdf,
] as const satisfies readonly ArtifactFidelity[];

export function artifactFidelityFor<Kind extends ArtifactWorkpieceKind>(
  kind: Kind,
): (typeof ARTIFACT_FIDELITY_BY_KIND)[Kind] {
  return ARTIFACT_FIDELITY_BY_KIND[kind];
}

export function artifactSurfaceCategoryFor(
  artifact: Pick<ArtifactDescriptor, "content_type" | "name">,
): ArtifactSurfaceCategory {
  const mime = normalizeArtifactContentType(artifact.content_type);
  if (mime.startsWith("image/") || mime.startsWith("video/")) return "media";
  if (mime.startsWith("text/") || mime === PDF_CONTENT_TYPE) return "docs";
  return SURFACE_DOCUMENT_EXTENSIONS.has(artifactFileExtension(artifact.name)) ? "docs" : "files";
}

export function isArtifactWorkpieceState<Kind extends ArtifactWorkpieceKind>(
  kind: Kind,
  value: unknown,
): value is ArtifactWorkpieceState<Kind> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  const entry = entries[0];
  if (entry === undefined || entries.length !== 1) {
    return false;
  }
  // Spreadsheet canonical state is the v2 workbook. v1 `{ csv }` inputs are
  // upgraded on load via `coerceSpreadsheetState`, never accepted as canonical.
  if (kind === "spreadsheet") return entry[0] === "workbook" && normalizeWorkbook(entry[1]) !== null;
  if (kind === "document") {
    // Canonical rich state is the v2 themed `{ document }`; v1 `{ html }` inputs
    // upgrade on load via `coerceDocumentState`, never accepted as canonical. The
    // plain-text `{ text }` source form (markdown / txt) is also canonical.
    if (entry[0] === "text") return typeof entry[1] === "string";
    return entry[0] === "document" && normalizeDocument(entry[1]) !== null;
  }
  if (kind === "pdf") return entry[0] === "pdfText" && typeof entry[1] === "string";
  // Presentation canonical state is the v2 deck. v1 `{ slides }` inputs are
  // upgraded on load via `coercePresentationState`, never accepted as canonical.
  return entry[0] === "deck" && normalizeDeck(entry[1]) !== null;
}
