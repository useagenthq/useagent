export const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const PDF_CONTENT_TYPE = "application/pdf";

export const MAX_WORKPIECE_STATE_BYTES = 1_000_000;
export const MAX_RICH_WORKPIECE_SOURCE_BYTES = 10_000_000;
/** Kept on the wire until readers that required the original tuple have retired. */
export const ARTIFACT_LEGACY_WORKPIECE_ACTIONS = ["preview", "download", "edit"] as const;
export const ARTIFACT_WORKPIECE_ACTIONS = ["preview", "download", "edit", "export"] as const;
export const ARTIFACT_ACTIONS = ARTIFACT_WORKPIECE_ACTIONS;
export const ARTIFACT_AUTHORING_ACTIONS = ["create", "publish"] as const;

export type ArtifactWorkpieceAction = (typeof ARTIFACT_WORKPIECE_ACTIONS)[number];
export type ArtifactAction = (typeof ARTIFACT_ACTIONS)[number];
export type ArtifactAuthoringAction = (typeof ARTIFACT_AUTHORING_ACTIONS)[number];
export type ArtifactWorkpieceKind = "document" | "spreadsheet" | "presentation" | "pdf";

/** The legacy (v1) slide shape: a title, body, and optional speaker notes. Kept
 * because it is what a PPTX text extraction yields and what a v1 state upgrades
 * from; the canonical presentation state is the v2 deck below. */
export interface ArtifactPresentationSlide {
  readonly title: string;
  readonly body: string;
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// Presentation deck v2 (web-native canonical model).
//
// A deck is a theme plus an ordered list of slides; each slide is a list of
// absolutely-positioned blocks on a 16:9 reference canvas. Block coordinates are
// PERCENTAGES of the reference so the one renderer draws at any scale (full
// canvas and filmstrip thumbnail alike). Deck theme colors are DOCUMENT data
// (like the brand-mark exception), so they carry raw hex values, not tokens.
// ---------------------------------------------------------------------------

/** Bumped when the deck shape changes; v1 title/body states upgrade to this. */
export const PRESENTATION_SCHEMA_VERSION = 2 as const;
/** The reference canvas that block percentages and font sizes are relative to. */
export const DECK_REFERENCE_WIDTH = 1920;
export const DECK_REFERENCE_HEIGHT = 1080;

export type DeckBlockType = "heading" | "text" | "image" | "shape";
export type DeckTextAlign = "left" | "center" | "right";

export interface DeckBlockStyle {
  /** Text color override (hex `#rgb`/`#rrggbb`); falls back to the theme role. */
  readonly color?: string;
  /** Font size in px on the 1080-tall reference (renderer + export scale it). */
  readonly fontSize?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly align?: DeckTextAlign;
  /** Shape fill (hex); falls back to the theme accent for shape blocks. */
  readonly fill?: string;
  /** Shape corner radius in px on the reference. */
  readonly radius?: number;
}

export interface DeckBlock {
  readonly id: string;
  readonly type: DeckBlockType;
  /** Percent of the reference width/height (0-100). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** heading/text: the text; image: an asset URL; shape: unused (uses fill). */
  readonly content: string;
  readonly style?: DeckBlockStyle;
}

export type DeckBackground =
  | Readonly<{ type: "color"; color: string }>
  | Readonly<{ type: "gradient"; from: string; to: string; angle?: number }>
  | Readonly<{ type: "image"; url: string }>;

export interface DeckTheme {
  readonly background: DeckBackground;
  /** Default heading text color (hex). */
  readonly heading: string;
  /** Default body text color (hex). */
  readonly body: string;
  /** Accent color for shapes and rules (hex). */
  readonly accent: string;
}

export interface DeckSlide {
  readonly id: string;
  readonly blocks: readonly DeckBlock[];
  /** Optional per-slide background override; falls back to the deck theme. */
  readonly background?: DeckBackground;
  readonly notes?: string;
}

export interface PresentationDeck {
  readonly schemaVersion: typeof PRESENTATION_SCHEMA_VERSION;
  readonly theme: DeckTheme;
  readonly slides: readonly DeckSlide[];
}

// ---------------------------------------------------------------------------
// Spreadsheet workbook v2 (web-native canonical model).
//
// A workbook is an ordered list of worksheets; each worksheet is a sparse map of
// A1-keyed cells (only populated cells are stored) plus its own dimensions and
// per-column widths. A cell carries a raw value, an optional `=formula` (the
// formula is the source of truth; the display value is computed on the client by
// the bounded formula engine), and optional presentation format. Cell fill/text
// colors are DOCUMENT data, so they carry raw hex values, not tokens. v1 `{ csv }`
// states upgrade on load (see `coerceSpreadsheetState`) so stored rows never break.
// ---------------------------------------------------------------------------

/** Bumped when the workbook shape changes; v1 `{ csv }` states upgrade to this. */
export const SPREADSHEET_SCHEMA_VERSION = 2 as const;
/** Honest dimension caps (well below cloudflare-os's 50000x702). Clamped, never
 * a hard reject: an over-cap sheet is trimmed to fit, not dropped. */
export const SHEET_MAX_ROWS = 10_000;
export const SHEET_MAX_COLS = 256;
export const WORKBOOK_MAX_SHEETS = 20;
/** Per-cell text/formula ceiling so one pathological cell cannot bloat validation
 * before the overall MAX_WORKPIECE_STATE_BYTES check catches it. */
export const SHEET_MAX_CELL_LENGTH = 8_192;

export type SheetNumberFormat = "auto" | "currency" | "percent" | "0" | "0.00";
export type SheetCellAlign = "left" | "center" | "right";

export interface SheetCellFormat {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly align?: SheetCellAlign;
  readonly numFmt?: SheetNumberFormat;
  /** Cell fill color (hex `#rgb`/`#rrggbb`). */
  readonly fill?: string;
  /** Text color (hex `#rgb`/`#rrggbb`). */
  readonly color?: string;
}

export interface SheetCell {
  /** The raw entered value (a literal). Ignored for display when `f` is set. */
  readonly v: string | number;
  /** An `=formula`; when present it is the source of truth and the engine
   * computes the display value from it. */
  readonly f?: string;
  readonly fmt?: SheetCellFormat;
}

export interface Worksheet {
  readonly id: string;
  readonly name: string;
  /** Sparse cell map keyed by A1 reference (only populated cells are stored). */
  readonly cells: Readonly<Record<string, SheetCell>>;
  /** Per-column pixel widths keyed by column letter (A, B, ...); absent = default. */
  readonly colWidths?: Readonly<Record<string, number>>;
  readonly rowCount: number;
  readonly colCount: number;
}

export interface Workbook {
  readonly schemaVersion: typeof SPREADSHEET_SCHEMA_VERSION;
  readonly sheets: readonly Worksheet[];
  readonly activeSheetId: string;
}

// ---------------------------------------------------------------------------
// Themed document v2 (web-native canonical model for rich documents).
//
// A themed document is a deck-style theme (page background + heading/body/accent
// colors) plus the validated rich-HTML body. It supersedes the bare `{ html }`
// companion form; v1 `{ html }` states upgrade on load (see `coerceDocumentState`)
// so stored rows never break. Plain-text source documents keep the separate
// `{ text }` form (markdown / txt), which carries no theme. Document theme colors
// are DOCUMENT data (like the deck's), so they carry raw hex values, not tokens.
// ---------------------------------------------------------------------------

/** Bumped when the themed-document shape changes; v1 `{ html }` states upgrade. */
export const DOCUMENT_SCHEMA_VERSION = 2 as const;

/** A document theme: the same background union + heading/body/accent roles the
 * deck theme uses, so the picker and presets are shared. */
export interface DocumentTheme {
  readonly background: DeckBackground;
  /** Default heading text color (hex). */
  readonly heading: string;
  /** Default body text color (hex). */
  readonly body: string;
  /** Accent color (used in the browser view; not mapped into DOCX). */
  readonly accent: string;
}

export interface ThemedDocument {
  readonly schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
  readonly theme: DocumentTheme;
  /** The validated rich-HTML body (the deliberately small safe subset). */
  readonly html: string;
}

export interface ArtifactWorkpieceStateByKind {
  /** Canonical rich form: `{ document }`. v1 `{ html }` upgrades on load (see
   * `coerceDocumentState`). Plain-text source docs keep the separate `{ text }`. */
  readonly document: Readonly<{ text: string }> | Readonly<{ document: ThemedDocument }>;
  /** Canonical v2 form: `{ workbook }`. v1 `{ csv }` states upgrade on load
   * (see `coerceSpreadsheetState`) so stored v1 rows never break. */
  readonly spreadsheet: Readonly<{ workbook: Workbook }>;
  /** Canonical v2 form: `{ deck }`. v1 `{ slides }` states upgrade on load
   * (see `coercePresentationState`) so stored v1 rows never break. */
  readonly presentation: Readonly<{ deck: PresentationDeck }>;
  readonly pdf: Readonly<{ pdfText: string }>;
}

export type ArtifactWorkpieceState<
  Kind extends ArtifactWorkpieceKind = ArtifactWorkpieceKind,
> = ArtifactWorkpieceStateByKind[Kind];

export interface ArtifactDescriptor {
  readonly id: string;
  readonly run_id: string;
  readonly thread_id: string;
  readonly name: string;
  readonly source_path: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly created_at: string;
  readonly preview_url: string;
  readonly download_url: string;
  readonly workpiece: ArtifactWorkpieceDescriptor | null;
}

export type ArtifactWorkpieceDescriptor<
  Kind extends ArtifactWorkpieceKind = ArtifactWorkpieceKind,
> = Kind extends ArtifactWorkpieceKind
  ? Readonly<{
    readonly kind: Kind;
    /** Immutable source identity. A changed source produces a new artifact digest. */
    readonly source_version: string;
    readonly state_revision: number;
    readonly state_url: string;
    /** Additive rolling-deploy metadata; absent on the original workpiece contract. */
    readonly export_url?: string;
    readonly exports?: readonly ArtifactWorkpieceExport[];
    readonly actions: readonly ArtifactWorkpieceAction[];
  }>
  : never;

export interface ArtifactWorkpieceExport {
  readonly format: "text" | "html" | "csv" | "json" | "docx" | "xlsx" | "pptx" | "pdf";
  readonly label: string;
  readonly extension: "txt" | "html" | "csv" | "json" | "docx" | "xlsx" | "pptx" | "pdf";
  readonly content_type: string;
  readonly native: boolean;
}

export type ArtifactWorkpieceResult<
  Kind extends ArtifactWorkpieceKind = ArtifactWorkpieceKind,
> = Kind extends ArtifactWorkpieceKind
  ? Readonly<{
    readonly workpiece: ArtifactWorkpieceDescriptor<Kind>;
    readonly state: ArtifactWorkpieceState<Kind> | null;
  }>
  : never;

// Agent-proposed workpiece revisions. An agent edit lands as a "pending"
// proposal that leaves mainline untouched until an explicit accept folds it in;
// a dismissed proposal is recorded, not erased. Shared wire contract for the
// backend proposal endpoints and the browser review UI.
export const ARTIFACT_PROPOSAL_STATUSES = ["pending", "accepted", "dismissed"] as const;
export type ArtifactProposalStatus = (typeof ARTIFACT_PROPOSAL_STATUSES)[number];

export interface ArtifactWorkpieceProposalDescriptor<
  Kind extends ArtifactWorkpieceKind = ArtifactWorkpieceKind,
> {
  readonly id: string;
  readonly artifact_id: string;
  /** The run whose agent proposed this revision (provenance). */
  readonly proposer_run_id: string;
  readonly kind: Kind;
  /** The mainline state_revision this proposal was authored against. */
  readonly base_revision: number;
  readonly summary: string | null;
  readonly status: ArtifactProposalStatus;
  readonly created_at: string;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
  /** The mainline revision this proposal produced when accepted. */
  readonly resolved_revision: number | null;
  /** Full proposed state, so the review UI can diff without a second fetch. */
  readonly state: ArtifactWorkpieceState<Kind>;
}
