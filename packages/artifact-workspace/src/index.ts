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

export * from "./contracts";

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

const SAFE_RICH_HTML_TAGS = new Set([
  "a",
  "b",
  "br",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "i",
  "li",
  "ol",
  "p",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);
const RICH_HTML_TABLE_CELL_TAGS = new Set(["td", "th"]);

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
    defaultState: (_name: string) => ({ csv: "Name,Value\n" }),
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
      slides: [{ title: artifactNameStem(name), body: "", notes: "" }],
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

export function parseArtifactCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (character !== "\r") {
      cell += character;
    }
  }
  row.push(cell);
  if (row.some((value) => value.length > 0) || rows.length === 0) rows.push(row);
  return rows;
}

export function serializeArtifactCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) =>
    row.map((value) => /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)
      .join(",")
  ).join("\n");
}

export function isArtifactRichHtmlTag(tag: string): boolean {
  return SAFE_RICH_HTML_TAGS.has(tag.toLowerCase());
}

export function isArtifactRichHtmlAttribute(
  tag: string,
  name: string,
  value: string,
): boolean {
  const normalizedTag = tag.toLowerCase();
  const normalizedName = name.toLowerCase();
  if (normalizedName === "href") {
    const href = value.trim().toLowerCase();
    return normalizedTag === "a" &&
      (href.startsWith("https://") || href.startsWith("http://") || href.startsWith("mailto:"));
  }
  if (normalizedName !== "colspan" && normalizedName !== "rowspan") return false;
  if (!RICH_HTML_TABLE_CELL_TAGS.has(normalizedTag) || !/^\d{1,3}$/.test(value)) return false;
  const span = Number(value);
  return span >= 1 && span <= 100;
}

function hasSafeRichHtmlAttributes(tag: string, source: string): boolean {
  let remaining = source.trim();
  if (!remaining) return true;
  if (remaining.endsWith("/")) {
    if (tag !== "br") return false;
    remaining = remaining.slice(0, -1).trimEnd();
  }

  const seen = new Set<string>();
  while (remaining) {
    const match =
      /^([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))(?:\s+|$)/i.exec(
        remaining,
      );
    if (!match) return false;
    const rawName = match[1];
    if (!rawName) return false;
    const name = rawName.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (seen.has(name) || !isArtifactRichHtmlAttribute(tag, name, value)) return false;
    seen.add(name);
    remaining = remaining.slice(match[0].length);
  }
  return true;
}

/** Validate the browser editor's deliberately small rich-HTML subset. Unknown
 * tags, misplaced attributes, unsafe URL schemes, and malformed markup fail
 * closed so browser and server consumers enforce one storage contract. */
export function normalizeArtifactRichHtml(value: string): string | null {
  const tags = value.matchAll(/<[^>]*>/g);
  let cursor = 0;
  for (const match of tags) {
    const start = match.index;
    if (start === undefined || /[<>]/.test(value.slice(cursor, start))) return null;
    const parsed = /^<\s*(\/?)\s*([a-z][a-z0-9]*)\s*([^>]*)>$/i.exec(match[0]);
    if (!parsed) return null;
    const closing = parsed[1] === "/";
    const rawTag = parsed[2];
    if (!rawTag) return null;
    const tag = rawTag.toLowerCase();
    const attributes = parsed[3] ?? "";
    if (!isArtifactRichHtmlTag(tag)) return null;
    if (closing ? attributes.trim() !== "" : !hasSafeRichHtmlAttributes(tag, attributes)) {
      return null;
    }
    cursor = start + match[0].length;
  }
  return /[<>]/.test(value.slice(cursor)) ? null : value;
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
  if (kind === "spreadsheet") return entry[0] === "csv" && typeof entry[1] === "string";
  if (kind === "document") {
    return (entry[0] === "text" || entry[0] === "html") && typeof entry[1] === "string";
  }
  if (kind === "pdf") return entry[0] === "pdfText" && typeof entry[1] === "string";
  if (entry[0] !== "slides" || !Array.isArray(entry[1]) || entry[1].length > 200) return false;
  return entry[1].every((slide) => {
    const item = record(slide);
    return !!item &&
      typeof item.title === "string" &&
      typeof item.body === "string" &&
      (item.notes === undefined || typeof item.notes === "string");
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
