// Pure spreadsheet-workbook logic shared by the backend control plane and the
// browser. ONE definition of the v2 workbook model lives here: validation (a
// security boundary for agent- and user-supplied state), deterministic v1<->v2
// migration (CSV -> single-sheet workbook; workbook -> CSV downgrade that loses
// formulas/formatting but keeps values), A1 helpers, and small workbook helpers
// the grid, engine, and exporters reuse. No I/O, no DOM. The formula engine lives
// in `formula.ts`.

import { parseArtifactCsv, serializeArtifactCsv } from "./csv";
import {
  SHEET_MAX_CELL_LENGTH,
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  SPREADSHEET_SCHEMA_VERSION,
  WORKBOOK_MAX_SHEETS,
  type SheetCell,
  type SheetCellAlign,
  type SheetCellFormat,
  type SheetNumberFormat,
  type Workbook,
  type Worksheet,
} from "./contracts";

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const A1_REF = /^([A-Za-z]+)([1-9]\d*)$/;
const COLUMN_LABEL = /^[A-Za-z]+$/;
const NUMBER_FORMATS: readonly SheetNumberFormat[] = ["auto", "currency", "percent", "0", "0.00"];
const ALIGNS: readonly SheetCellAlign[] = ["left", "center", "right"];
/** Column-width clamp so a hostile width cannot break the grid layout. */
const MIN_COL_WIDTH = 40;
const MAX_COL_WIDTH = 1000;
export const DEFAULT_COL_WIDTH = 128;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeText(value: unknown, max = SHEET_MAX_CELL_LENGTH): value is string {
  return typeof value === "string" && value.length <= max && !CONTROL_CHARS.test(value);
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

// --- A1 helpers ------------------------------------------------------------

/** Zero-based column index to its A1 label: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLabel(index: number): string {
  let label = "";
  let n = index;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/** A1 column label to its zero-based index, or -1 when malformed. */
export function columnIndex(label: string): number {
  if (!COLUMN_LABEL.test(label)) return -1;
  let index = 0;
  for (const character of label.toUpperCase()) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
}

/** Parse an A1 reference into zero-based { row, col }, or null when malformed. */
export function parseA1(ref: string): { readonly row: number; readonly col: number } | null {
  const match = A1_REF.exec(ref);
  if (!match) return null;
  const col = columnIndex(match[1]!);
  const row = Number(match[2]) - 1;
  if (col < 0 || row < 0) return null;
  return { row, col };
}

/** Zero-based { row, col } to its A1 reference. */
export function formatA1(row: number, col: number): string {
  return `${columnLabel(col)}${row + 1}`;
}

// --- Validation / normalization (fails closed) -----------------------------

function normalizeCellFormat(value: unknown): SheetCellFormat | undefined {
  const item = record(value);
  if (!item) return undefined;
  const fmt: {
    bold?: boolean;
    italic?: boolean;
    align?: SheetCellAlign;
    numFmt?: SheetNumberFormat;
    fill?: string;
    color?: string;
  } = {};
  if (item.bold === true) fmt.bold = true;
  if (item.italic === true) fmt.italic = true;
  if (typeof item.align === "string" && ALIGNS.includes(item.align as SheetCellAlign)) {
    fmt.align = item.align as SheetCellAlign;
  }
  if (typeof item.numFmt === "string" && NUMBER_FORMATS.includes(item.numFmt as SheetNumberFormat)) {
    fmt.numFmt = item.numFmt as SheetNumberFormat;
  }
  if (isHexColor(item.fill)) fmt.fill = item.fill;
  if (isHexColor(item.color)) fmt.color = item.color;
  return Object.keys(fmt).length > 0 ? fmt : undefined;
}

function normalizeCell(value: unknown): SheetCell | null {
  const item = record(value);
  if (!item) return null;
  let f: string | undefined;
  if (item.f !== undefined && item.f !== null) {
    if (!safeText(item.f) || !item.f.startsWith("=")) return null;
    f = item.f;
  }
  let v: string | number;
  if (typeof item.v === "number" && Number.isFinite(item.v)) {
    v = item.v;
  } else if (safeText(item.v)) {
    v = item.v;
  } else if (f !== undefined) {
    v = "";
  } else {
    return null;
  }
  const fmt = normalizeCellFormat(item.fmt);
  return { v, ...(f !== undefined ? { f } : {}), ...(fmt ? { fmt } : {}) };
}

/** Validate and normalize one worksheet. Dimensions are clamped to the caps;
 * cells with a malformed A1 key or a position beyond the caps are dropped (fail
 * closed), and the effective dimensions grow to include every kept cell. */
function normalizeWorksheet(value: unknown): Worksheet | null {
  const item = record(value);
  if (!item) return null;
  if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 128) return null;
  if (!safeText(item.name, 128) || item.name.length === 0) return null;

  const cellsInput = record(item.cells);
  if (item.cells !== undefined && item.cells !== null && !cellsInput) return null;
  const cells: Record<string, SheetCell> = {};
  let maxRow = 0;
  let maxCol = 0;
  for (const [key, raw] of Object.entries(cellsInput ?? {})) {
    const position = parseA1(key);
    // A malformed A1 key is a structural violation: fail the whole sheet closed
    // (like the deck rejecting a bad block), never silently drop a mystery key.
    if (!position) return null;
    // A cell beyond the honest caps is trimmed away (the dimension clamp).
    if (position.row >= SHEET_MAX_ROWS || position.col >= SHEET_MAX_COLS) continue;
    // Unsafe content (control chars, wrong value type, a formula missing =) also
    // fails closed rather than dropping the offending cell.
    const cell = normalizeCell(raw);
    if (!cell) return null;
    const ref = formatA1(position.row, position.col);
    cells[ref] = cell;
    if (position.row > maxRow) maxRow = position.row;
    if (position.col > maxCol) maxCol = position.col;
  }

  const rowCount = clampInt(item.rowCount, Math.max(1, maxRow + 1), SHEET_MAX_ROWS, maxRow + 1);
  const colCount = clampInt(item.colCount, Math.max(1, maxCol + 1), SHEET_MAX_COLS, maxCol + 1);

  let colWidths: Record<string, number> | undefined;
  const widthsInput = record(item.colWidths);
  if (item.colWidths !== undefined && item.colWidths !== null && !widthsInput) return null;
  if (widthsInput) {
    const widths: Record<string, number> = {};
    for (const [key, raw] of Object.entries(widthsInput)) {
      const index = columnIndex(key);
      if (index < 0 || index >= colCount) continue;
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      widths[columnLabel(index)] = clampInt(raw, MIN_COL_WIDTH, MAX_COL_WIDTH, DEFAULT_COL_WIDTH);
    }
    if (Object.keys(widths).length > 0) colWidths = widths;
  }

  return {
    id: item.id,
    name: item.name,
    cells,
    rowCount,
    colCount,
    ...(colWidths ? { colWidths } : {}),
  };
}

/** Validate and normalize an unknown value into a canonical v2 workbook, or null.
 * Fails closed: bad structure, unsafe text/colors, duplicate sheet ids, or an
 * empty sheet list all yield null. Dimensions and widths are clamped, not
 * rejected. `activeSheetId` falls back to the first sheet when it is unknown. */
export function normalizeWorkbook(value: unknown): Workbook | null {
  const item = record(value);
  if (!item) return null;
  if (item.schemaVersion !== SPREADSHEET_SCHEMA_VERSION) return null;
  if (!Array.isArray(item.sheets) || item.sheets.length === 0) return null;
  if (item.sheets.length > WORKBOOK_MAX_SHEETS) return null;
  const sheets: Worksheet[] = [];
  const ids = new Set<string>();
  for (const raw of item.sheets) {
    const sheet = normalizeWorksheet(raw);
    if (!sheet || ids.has(sheet.id)) return null;
    ids.add(sheet.id);
    sheets.push(sheet);
  }
  const activeSheetId = typeof item.activeSheetId === "string" && ids.has(item.activeSheetId)
    ? item.activeSheetId
    : sheets[0]!.id;
  return { schemaVersion: SPREADSHEET_SCHEMA_VERSION, sheets, activeSheetId };
}

// --- Deterministic migration (v1 <-> v2) -----------------------------------

/** Deterministically upgrade a v1 CSV state into a single-sheet v2 workbook.
 * Pure: the same CSV always produces the same workbook (fixed sheet id/name,
 * cell values only). */
export function csvToWorkbook(csv: string, name = "Sheet 1"): Workbook {
  const rows = parseArtifactCsv(csv);
  const cells: Record<string, SheetCell> = {};
  let colCount = 1;
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    if (row.length > colCount) colCount = row.length;
    for (let c = 0; c < row.length; c += 1) {
      const raw = row[c] ?? "";
      if (raw.length === 0) continue;
      cells[formatA1(r, c)] = { v: raw };
    }
  }
  const sheet: Worksheet = {
    id: "sheet-1",
    name,
    cells,
    rowCount: Math.max(1, Math.min(SHEET_MAX_ROWS, rows.length)),
    colCount: Math.max(1, Math.min(SHEET_MAX_COLS, colCount)),
  };
  return { schemaVersion: SPREADSHEET_SCHEMA_VERSION, sheets: [sheet], activeSheetId: sheet.id };
}

/** The scalar a cell contributes to the CSV downgrade: a formula cell emits its
 * cached value `v` (the last computed result), a literal cell emits `v`. */
function cellCsvValue(cell: SheetCell): string {
  return typeof cell.v === "number" ? String(cell.v) : cell.v;
}

/** The worksheet backing the workbook's active tab (falls back to the first). */
export function activeWorksheet(workbook: Workbook): Worksheet {
  return workbook.sheets.find((sheet) => sheet.id === workbook.activeSheetId) ?? workbook.sheets[0]!;
}

/** Downgrade a workbook to a v1 CSV string of the ACTIVE sheet's values. Lossy by
 * design (formulas become their cached values; formatting, other sheets, and
 * widths are dropped) but every value survives - the documented v2 -> v1 edge. */
export function workbookToCsv(workbook: Workbook): string {
  const sheet = activeWorksheet(workbook);
  let maxRow = -1;
  let maxCol = -1;
  for (const ref of Object.keys(sheet.cells)) {
    const position = parseA1(ref);
    if (!position) continue;
    if (position.row > maxRow) maxRow = position.row;
    if (position.col > maxCol) maxCol = position.col;
  }
  if (maxRow < 0) return "";
  const rows: string[][] = [];
  for (let r = 0; r <= maxRow; r += 1) {
    const row: string[] = [];
    for (let c = 0; c <= maxCol; c += 1) {
      const cell = sheet.cells[formatA1(r, c)];
      row.push(cell ? cellCsvValue(cell) : "");
    }
    rows.push(row);
  }
  return serializeArtifactCsv(rows);
}

// --- Coercion into canonical state -----------------------------------------

/** Coerce any accepted spreadsheet input into a canonical v2 workbook:
 *  - `{ workbook }`      -> validate the workbook
 *  - a bare workbook     -> validate it directly
 *  - `{ csv }`           -> migrate the CSV to a single-sheet workbook
 *  - a bare CSV string   -> migrate
 * Returns null on anything invalid. This is the single upgrade-on-load path both
 * the backend (write + read boundaries) and the browser funnel through. */
export function coerceWorkbook(value: unknown): Workbook | null {
  if (typeof value === "string") return csvToWorkbook(value);
  const item = record(value);
  if (!item) return null;
  if ("workbook" in item) return normalizeWorkbook(item.workbook);
  if (item.schemaVersion === SPREADSHEET_SCHEMA_VERSION) return normalizeWorkbook(item);
  if ("csv" in item) return typeof item.csv === "string" ? csvToWorkbook(item.csv) : null;
  return null;
}

/** Coerce into the canonical `{ workbook }` state, or null. */
export function coerceSpreadsheetState(value: unknown): Readonly<{ workbook: Workbook }> | null {
  const workbook = coerceWorkbook(value);
  return workbook ? { workbook } : null;
}

// --- Editor helpers (workbook + sheet factories) ---------------------------

/** A fresh empty worksheet with the supplied id and name. */
export function emptyWorksheet(id: string, name: string): Worksheet {
  return { id, name, cells: {}, rowCount: 20, colCount: 8 };
}

/** A fresh single-sheet workbook (used as the editor's blank-slate fallback). */
export function emptyWorkbook(): Workbook {
  const sheet = emptyWorksheet("sheet-1", "Sheet 1");
  return { schemaVersion: SPREADSHEET_SCHEMA_VERSION, sheets: [sheet], activeSheetId: sheet.id };
}

/** The effective width of a column (its override, else the default). */
export function columnWidth(sheet: Worksheet, col: number): number {
  return sheet.colWidths?.[columnLabel(col)] ?? DEFAULT_COL_WIDTH;
}

export { SHEET_MAX_COLS, SHEET_MAX_ROWS, SPREADSHEET_SCHEMA_VERSION, WORKBOOK_MAX_SHEETS };
