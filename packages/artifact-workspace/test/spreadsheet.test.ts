import { describe, expect, test } from "bun:test";
import {
  activeWorksheet,
  coerceSpreadsheetState,
  coerceWorkbook,
  columnIndex,
  columnLabel,
  columnWidth,
  csvToWorkbook,
  formatA1,
  isArtifactWorkpieceState,
  normalizeWorkbook,
  parseA1,
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  SPREADSHEET_SCHEMA_VERSION,
  workbookToCsv,
  type Workbook,
} from "../src";

// A control character the validator must reject in any cell value/formula.
const BELL = String.fromCharCode(7);

describe("A1 helpers", () => {
  test("column label <-> index round-trips", () => {
    expect(columnLabel(0)).toBe("A");
    expect(columnLabel(25)).toBe("Z");
    expect(columnLabel(26)).toBe("AA");
    expect(columnIndex("A")).toBe(0);
    expect(columnIndex("Z")).toBe(25);
    expect(columnIndex("AA")).toBe(26);
    expect(columnIndex("a1")).toBe(-1);
  });

  test("parseA1 / formatA1 round-trip and reject junk", () => {
    expect(parseA1("B3")).toEqual({ row: 2, col: 1 });
    expect(formatA1(2, 1)).toBe("B3");
    expect(parseA1("A0")).toBeNull();
    expect(parseA1("3")).toBeNull();
    expect(parseA1("!")).toBeNull();
  });
});

describe("csv <-> workbook migration", () => {
  const csv = "Region,Pipeline\nAPAC,1200000\nEMEA,980000";

  test("csvToWorkbook is deterministic and builds a valid single-sheet workbook", () => {
    const a = csvToWorkbook(csv);
    const b = csvToWorkbook(csv);
    expect(a).toEqual(b);
    expect(a.schemaVersion).toBe(SPREADSHEET_SCHEMA_VERSION);
    expect(a.sheets).toHaveLength(1);
    expect(a.activeSheetId).toBe("sheet-1");
    expect(a.sheets[0]!.cells.A1).toEqual({ v: "Region" });
    expect(a.sheets[0]!.cells.A2).toEqual({ v: "APAC" });
    expect(a.sheets[0]!.cells.B3).toEqual({ v: "980000" });
    expect(a.sheets[0]!.rowCount).toBe(3);
    expect(a.sheets[0]!.colCount).toBe(2);
    // The canonical `{ workbook }` state passes the shared type guard.
    expect(isArtifactWorkpieceState("spreadsheet", { workbook: a })).toBe(true);
  });

  test("workbook -> csv downgrade keeps values (formula cells emit their cached v)", () => {
    const workbook: Workbook = {
      schemaVersion: 2,
      activeSheetId: "sheet-1",
      sheets: [{
        id: "sheet-1",
        name: "Sheet 1",
        rowCount: 3,
        colCount: 2,
        cells: {
          A1: { v: "Region" },
          B1: { v: "Pipeline", fmt: { bold: true } },
          A2: { v: "APAC" },
          B2: { v: 1200000, fmt: { numFmt: "currency" } },
          // A formula cell downgrades to its cached value, never the formula text.
          B3: { v: 1200000, f: "=SUM(B2:B2)" },
        },
      }],
    };
    expect(workbookToCsv(workbook)).toBe("Region,Pipeline\nAPAC,1200000\n,1200000");
  });

  test("csv -> workbook -> csv round-trips the value grid", () => {
    expect(workbookToCsv(csvToWorkbook(csv))).toBe(csv);
  });
});

describe("coerceSpreadsheetState (upgrade on load)", () => {
  test("upgrades v1 { csv }, a bare csv string, and passes a v2 workbook through", () => {
    const fromWrapped = coerceSpreadsheetState({ csv: "a,b\n1,2" });
    expect(fromWrapped?.workbook.schemaVersion).toBe(SPREADSHEET_SCHEMA_VERSION);
    expect(fromWrapped?.workbook.sheets[0]!.cells.A1).toEqual({ v: "a" });

    const fromString = coerceWorkbook("a,b\n1,2");
    expect(fromString).toEqual(fromWrapped!.workbook);

    const workbook = csvToWorkbook("a,b");
    expect(coerceSpreadsheetState({ workbook })).toEqual({ workbook });
    // A bare workbook object (no wrapper) is accepted too.
    expect(coerceWorkbook(workbook)).toEqual(workbook);
  });

  test("fails closed on unsafe or malformed input", () => {
    expect(coerceSpreadsheetState(42)).toBeNull();
    expect(coerceSpreadsheetState({ csv: 42 })).toBeNull();
    // A control character in a cell value fails closed.
    expect(coerceWorkbook({
      schemaVersion: 2,
      activeSheetId: "sheet-1",
      sheets: [{ id: "sheet-1", name: "Sheet 1", rowCount: 1, colCount: 1, cells: { A1: { v: `Bad${BELL}` } } }],
    })).toBeNull();
    // A formula that does not start with = fails closed.
    expect(coerceWorkbook({
      schemaVersion: 2,
      activeSheetId: "sheet-1",
      sheets: [{ id: "sheet-1", name: "Sheet 1", rowCount: 1, colCount: 1, cells: { A1: { v: "", f: "SUM(A2)" } } }],
    })).toBeNull();
    // A malformed A1 cell key fails the whole sheet closed.
    expect(coerceWorkbook({
      schemaVersion: 2,
      activeSheetId: "sheet-1",
      sheets: [{ id: "sheet-1", name: "Sheet 1", rowCount: 1, colCount: 1, cells: { "not-a-ref": { v: "x" } } }],
    })).toBeNull();
    // Duplicate sheet ids fail closed.
    expect(coerceWorkbook({
      schemaVersion: 2,
      activeSheetId: "s",
      sheets: [
        { id: "s", name: "One", rowCount: 1, colCount: 1, cells: {} },
        { id: "s", name: "Two", rowCount: 1, colCount: 1, cells: {} },
      ],
    })).toBeNull();
    // An empty sheet list fails closed.
    expect(coerceWorkbook({ schemaVersion: 2, activeSheetId: "x", sheets: [] })).toBeNull();
    // The wrong schema version fails closed.
    expect(normalizeWorkbook({ ...csvToWorkbook("a"), schemaVersion: 1 })).toBeNull();
  });
});

describe("normalizeWorkbook (fail-closed clamps)", () => {
  test("clamps dimensions to the caps and trims cells beyond them", () => {
    const normalized = normalizeWorkbook({
      schemaVersion: 2,
      activeSheetId: "missing-id",
      sheets: [{
        id: "sheet-1",
        name: "Sheet 1",
        rowCount: 9_999_999,
        colCount: 9_999_999,
        cells: {
          A1: { v: "keep" },
          A10001: { v: "beyond the row cap" }, // row index 10000 >= SHEET_MAX_ROWS -> trimmed
        },
      }],
    });
    expect(normalized).not.toBeNull();
    const sheet = normalized!.sheets[0]!;
    expect(sheet.rowCount).toBe(SHEET_MAX_ROWS);
    expect(sheet.colCount).toBe(SHEET_MAX_COLS);
    expect(sheet.cells.A1).toEqual({ v: "keep" });
    expect(sheet.cells.A10001).toBeUndefined();
    // Unknown activeSheetId falls back to the first sheet.
    expect(normalized!.activeSheetId).toBe("sheet-1");
  });

  test("clamps column widths and keeps them keyed by column letter", () => {
    const workbook = normalizeWorkbook({
      schemaVersion: 2,
      activeSheetId: "sheet-1",
      sheets: [{
        id: "sheet-1",
        name: "Sheet 1",
        rowCount: 2,
        colCount: 3,
        cells: {},
        colWidths: { A: 5, B: 200, Z: 100 },
      }],
    });
    const sheet = workbook!.sheets[0]!;
    expect(sheet.colWidths?.A).toBe(40); // clamped up to the minimum
    expect(sheet.colWidths?.B).toBe(200);
    // Z is beyond colCount (3) -> dropped.
    expect(sheet.colWidths?.Z).toBeUndefined();
    expect(columnWidth(sheet, 1)).toBe(200);
    expect(columnWidth(sheet, 2)).toBe(128); // default
  });
});

describe("activeWorksheet", () => {
  test("returns the active sheet, falling back to the first", () => {
    const workbook = csvToWorkbook("a");
    expect(activeWorksheet(workbook).id).toBe("sheet-1");
    expect(activeWorksheet({ ...workbook, activeSheetId: "nope" }).id).toBe("sheet-1");
  });
});
