"use client";

// The web-native spreadsheet grid over the canonical v2 workbook. It renders the
// active sheet's computed cells (via the shared formula engine), a value bar that
// shows the RAW formula while the cell shows the computed value, a number-format +
// styling toolbar, multi-sheet tabs (add / rename / reorder), and column-width
// drag. Cell fill/text colors are DOCUMENT data, so they apply as raw inline
// styles; the surrounding chrome uses semantic tokens. The visible grid is capped
// (windowed) so a 10000-row sheet never renders raw.

import {
  RiAddLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiBold,
  RiItalic,
} from "@remixicon/react";
import {
  activeWorksheet,
  columnLabel,
  columnWidth,
  evaluateWorkbook,
  formatA1,
  parseA1,
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  WORKBOOK_MAX_SHEETS,
  type SheetCell,
  type SheetCellFormat,
  type SheetNumberFormat,
  type Workbook,
  type Worksheet,
} from "@skynet/artifact-workspace";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

/** Visible grid caps so a large sheet windows honestly instead of rendering raw. */
const VISIBLE_ROW_CAP = 200;
const VISIBLE_COL_CAP = 40;
const MIN_VISIBLE_ROWS = 12;
const MIN_VISIBLE_COLS = 6;
const MIN_COL_WIDTH = 56;

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// --- Pure workbook mutations -----------------------------------------------

function replaceSheet(workbook: Workbook, next: Worksheet): Workbook {
  return { ...workbook, sheets: workbook.sheets.map((sheet) => (sheet.id === next.id ? next : sheet)) };
}

function grownDimensions(sheet: Worksheet, row: number, col: number): Worksheet {
  const rowCount = Math.min(SHEET_MAX_ROWS, Math.max(sheet.rowCount, row + 1));
  const colCount = Math.min(SHEET_MAX_COLS, Math.max(sheet.colCount, col + 1));
  return rowCount === sheet.rowCount && colCount === sheet.colCount
    ? sheet
    : { ...sheet, rowCount, colCount };
}

/** Commit a raw cell input (a formula, a number, text, or empty) into the sheet.
 * A formula caches its computed value in `v` so the CSV/XLSX downgrade keeps a
 * value; a numeric input is stored as a number so number formats apply. */
export function commitCell(workbook: Workbook, sheetId: string, ref: string, raw: string): Workbook {
  const position = parseA1(ref);
  const sheet = workbook.sheets.find((item) => item.id === sheetId);
  if (!position || !sheet) return workbook;
  const prevFmt = sheet.cells[ref]?.fmt;
  const cells = { ...sheet.cells };

  if (raw === "") {
    if (prevFmt) cells[ref] = { v: "", fmt: prevFmt };
    else delete cells[ref];
  } else if (raw.startsWith("=")) {
    cells[ref] = { v: "", f: raw, ...(prevFmt ? { fmt: prevFmt } : {}) };
  } else if (NUMERIC.test(raw.trim())) {
    cells[ref] = { v: Number(raw.trim()), ...(prevFmt ? { fmt: prevFmt } : {}) };
  } else {
    cells[ref] = { v: raw, ...(prevFmt ? { fmt: prevFmt } : {}) };
  }

  let next = grownDimensions({ ...sheet, cells }, position.row, position.col);
  let workbookNext = replaceSheet(workbook, next);

  // Cache the formula's computed scalar into `v` (never the display string) so a
  // downgrade export keeps a real value. A boolean result caches as its text.
  if (raw.startsWith("=")) {
    const evaluated = evaluateWorkbook(workbookNext).cell(sheetId, ref);
    const result = evaluated.error ?? evaluated.value ?? "";
    const cached: string | number = typeof result === "boolean"
      ? result ? "TRUE" : "FALSE"
      : result;
    next = { ...next, cells: { ...next.cells, [ref]: { v: cached, f: raw, ...(prevFmt ? { fmt: prevFmt } : {}) } } };
    workbookNext = replaceSheet(workbook, next);
  }
  return workbookNext;
}

/** Apply a format patch to a cell (creating an empty cell to hold it if needed);
 * clearing a key (undefined/false/"") drops it, matching the block inspector. */
export function applyCellFormat(
  workbook: Workbook,
  sheetId: string,
  ref: string,
  patch: Partial<SheetCellFormat>,
): Workbook {
  const position = parseA1(ref);
  const sheet = workbook.sheets.find((item) => item.id === sheetId);
  if (!position || !sheet) return workbook;
  const existing = sheet.cells[ref];
  const fmt: Record<string, unknown> = { ...existing?.fmt };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === false || value === "") delete fmt[key];
    else fmt[key] = value;
  }
  const nextFmt = Object.keys(fmt).length > 0 ? (fmt as SheetCellFormat) : undefined;
  const cell: SheetCell = existing
    ? { ...existing, ...(nextFmt ? { fmt: nextFmt } : {}) }
    : { v: "", ...(nextFmt ? { fmt: nextFmt } : {}) };
  if (!nextFmt && "fmt" in cell) delete (cell as { fmt?: unknown }).fmt;
  // Drop a now-empty, unformatted cell entirely.
  const cells = { ...sheet.cells };
  if (cell.v === "" && cell.f === undefined && !nextFmt) delete cells[ref];
  else cells[ref] = cell;
  return replaceSheet(workbook, grownDimensions({ ...sheet, cells }, position.row, position.col));
}

function setColumnWidth(workbook: Workbook, sheetId: string, col: number, px: number): Workbook {
  const sheet = workbook.sheets.find((item) => item.id === sheetId);
  if (!sheet) return workbook;
  const colWidths = { ...sheet.colWidths, [columnLabel(col)]: Math.max(MIN_COL_WIDTH, Math.round(px)) };
  return replaceSheet(workbook, { ...sheet, colWidths });
}

function uniqueSheetId(workbook: Workbook): string {
  const ids = new Set(workbook.sheets.map((sheet) => sheet.id));
  let n = workbook.sheets.length + 1;
  while (ids.has(`sheet-${n}`)) n += 1;
  return `sheet-${n}`;
}

function addSheet(workbook: Workbook): Workbook {
  if (workbook.sheets.length >= WORKBOOK_MAX_SHEETS) return workbook;
  const id = uniqueSheetId(workbook);
  const names = new Set(workbook.sheets.map((sheet) => sheet.name));
  let index = workbook.sheets.length + 1;
  while (names.has(`Sheet ${index}`)) index += 1;
  const sheet: Worksheet = { id, name: `Sheet ${index}`, cells: {}, rowCount: 20, colCount: 8 };
  return { ...workbook, sheets: [...workbook.sheets, sheet], activeSheetId: id };
}

function renameSheet(workbook: Workbook, sheetId: string, name: string): Workbook {
  const trimmed = name.trim().slice(0, 128) || "Sheet";
  return {
    ...workbook,
    sheets: workbook.sheets.map((sheet) => (sheet.id === sheetId ? { ...sheet, name: trimmed } : sheet)),
  };
}

function moveSheet(workbook: Workbook, sheetId: string, delta: number): Workbook {
  const index = workbook.sheets.findIndex((sheet) => sheet.id === sheetId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= workbook.sheets.length) return workbook;
  const sheets = [...workbook.sheets];
  const moved = sheets[index]!;
  sheets[index] = sheets[target]!;
  sheets[target] = moved;
  return { ...workbook, sheets };
}

// --- UI --------------------------------------------------------------------

const NUMBER_FORMATS: readonly (readonly [SheetNumberFormat, string, string])[] = [
  ["auto", "Auto", "123"],
  ["currency", "Currency", "$"],
  ["percent", "Percent", "%"],
  ["0", "Integer", ".0"],
  ["0.00", "Two decimals", ".00"],
];

function toColorInput(hex: string | undefined, fallback: string): string {
  if (!hex) return fallback;
  const raw = hex.replace(/^#/, "");
  const six = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw.slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(six) ? `#${six}` : fallback;
}

function cellStyle(cell: SheetCell | undefined, numeric: boolean): CSSProperties {
  const fmt = cell?.fmt;
  return {
    fontWeight: fmt?.bold ? 700 : 400,
    fontStyle: fmt?.italic ? "italic" : "normal",
    textAlign: fmt?.align ?? (numeric ? "right" : "left"),
    ...(fmt?.color ? { color: fmt.color } : {}),
    ...(fmt?.fill ? { background: fmt.fill } : {}),
  };
}

export function SheetGridSurface({
  workbook,
  loading,
  onChange,
}: {
  readonly workbook: Workbook | null;
  readonly loading: boolean;
  readonly onChange: (workbook: Workbook) => void;
}) {
  const [selected, setSelected] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [draft, setDraft] = useState("");
  const [editingBar, setEditingBar] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const barRef = useRef<HTMLInputElement>(null);

  const sheet = workbook ? activeWorksheet(workbook) : null;
  const evaluation = useMemo(() => (workbook ? evaluateWorkbook(workbook) : null), [workbook]);

  const selectedRef = sheet ? formatA1(selected.row, selected.col) : "A1";
  const selectedCell = sheet?.cells[selectedRef];
  const rawOfSelected = selectedCell?.f ?? (selectedCell ? String(selectedCell.v) : "");

  // Keep the value bar in sync with the selected cell unless it is being edited.
  useEffect(() => {
    if (!editingBar) setDraft(rawOfSelected);
  }, [rawOfSelected, editingBar]);

  if (!workbook || !sheet || !evaluation) {
    return (
      <p className="mt-4 rounded-xl border border-dashed border-stroke-soft-200 px-4 py-8 text-center text-paragraph-sm text-text-sub-600">
        Loading workbook...
      </p>
    );
  }

  const visibleRows = Math.min(VISIBLE_ROW_CAP, Math.max(MIN_VISIBLE_ROWS, sheet.rowCount));
  const visibleCols = Math.min(VISIBLE_COL_CAP, Math.max(MIN_VISIBLE_COLS, sheet.colCount));
  const capped = sheet.rowCount > VISIBLE_ROW_CAP || sheet.colCount > VISIBLE_COL_CAP;

  const commitBar = () => {
    onChange(commitCell(workbook, sheet.id, selectedRef, draft));
    setEditingBar(false);
  };
  const patchFmt = (patch: Partial<SheetCellFormat>) =>
    onChange(applyCellFormat(workbook, sheet.id, selectedRef, patch));

  const startWidthDrag = (event: ReactPointerEvent, col: number) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = columnWidth(sheet, col);
    const move = (moveEvent: globalThis.PointerEvent) => {
      onChange(setColumnWidth(workbook, sheet.id, col, startWidth + (moveEvent.clientX - startX)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const fmt = selectedCell?.fmt;

  return (
    <section className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
      {/* Value bar: active cell ref + its RAW value/formula (the cell shows the
          computed value). */}
      <div className="flex items-center gap-2">
        <span className="inline-flex h-8 min-w-14 items-center justify-center rounded-lg border border-stroke-soft-200 bg-bg-weak-50 px-2 font-mono text-label-xs text-text-sub-600">
          {selectedRef}
        </span>
        <span className="font-mono text-label-xs text-text-soft-400" aria-hidden>
          fx
        </span>
        <input
          ref={barRef}
          value={draft}
          disabled={loading}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setEditingBar(true);
          }}
          onFocus={() => setEditingBar(true)}
          onBlur={commitBar}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitBar();
              setSelected((current) => ({
                row: Math.min(SHEET_MAX_ROWS - 1, current.row + 1),
                col: current.col,
              }));
            }
            if (event.key === "Escape") {
              setEditingBar(false);
              setDraft(rawOfSelected);
            }
          }}
          aria-label={`Value of cell ${selectedRef}`}
          placeholder="Value or =formula"
          className="h-8 min-w-0 flex-1 rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 font-mono text-paragraph-sm text-text-strong-950 outline-none focus:border-stroke-strong-950"
        />
      </div>

      {/* Format toolbar: number formats, bold/italic, alignment, fill + text color. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="inline-flex items-center rounded-lg border border-stroke-soft-200 p-0.5">
          {NUMBER_FORMATS.map(([value, title, glyph]) => (
            <button
              key={value}
              type="button"
              title={title}
              aria-label={title}
              aria-pressed={(fmt?.numFmt ?? "auto") === value}
              disabled={loading}
              onClick={() => patchFmt({ numFmt: value === "auto" ? undefined : value })}
              className="grid h-7 min-w-8 place-items-center rounded-md px-1.5 font-mono text-label-xs text-text-sub-600 hover:bg-bg-weak-50 aria-pressed:bg-bg-strong-950 aria-pressed:text-text-white-0 disabled:opacity-40"
            >
              {glyph}
            </button>
          ))}
        </div>
        <div className="mx-0.5 h-5 w-px bg-stroke-soft-200" aria-hidden />
        <button
          type="button"
          title="Bold"
          aria-label="Bold"
          aria-pressed={fmt?.bold ?? false}
          disabled={loading}
          onClick={() => patchFmt({ bold: !(fmt?.bold ?? false) })}
          className="grid size-8 place-items-center rounded-lg border border-stroke-soft-200 text-text-sub-600 hover:bg-bg-weak-50 aria-pressed:bg-bg-strong-950 aria-pressed:text-text-white-0 disabled:opacity-40"
        >
          <RiBold aria-hidden className="size-4" />
        </button>
        <button
          type="button"
          title="Italic"
          aria-label="Italic"
          aria-pressed={fmt?.italic ?? false}
          disabled={loading}
          onClick={() => patchFmt({ italic: !(fmt?.italic ?? false) })}
          className="grid size-8 place-items-center rounded-lg border border-stroke-soft-200 text-text-sub-600 hover:bg-bg-weak-50 aria-pressed:bg-bg-strong-950 aria-pressed:text-text-white-0 disabled:opacity-40"
        >
          <RiItalic aria-hidden className="size-4" />
        </button>
        <div className="inline-flex items-center rounded-lg border border-stroke-soft-200 p-0.5">
          {(["left", "center", "right"] as const).map((align) => (
            <button
              key={align}
              type="button"
              title={`Align ${align}`}
              aria-label={`Align ${align}`}
              aria-pressed={fmt?.align === align}
              disabled={loading}
              onClick={() => patchFmt({ align: fmt?.align === align ? undefined : align })}
              className="grid h-7 min-w-7 place-items-center rounded-md text-label-xs text-text-sub-600 hover:bg-bg-weak-50 aria-pressed:bg-bg-strong-950 aria-pressed:text-text-white-0 disabled:opacity-40"
            >
              {align === "left" ? "L" : align === "center" ? "C" : "R"}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1 text-label-xs text-text-sub-600">
          Fill
          <input
            type="color"
            aria-label="Cell fill color"
            value={toColorInput(fmt?.fill, "#ffffff")}
            disabled={loading}
            onChange={(event) => patchFmt({ fill: event.currentTarget.value })}
            className="h-7 w-8 cursor-pointer rounded border border-stroke-soft-200 bg-bg-white-0"
          />
        </label>
        <label className="inline-flex items-center gap-1 text-label-xs text-text-sub-600">
          Text
          <input
            type="color"
            aria-label="Cell text color"
            value={toColorInput(fmt?.color, "#000000")}
            disabled={loading}
            onChange={(event) => patchFmt({ color: event.currentTarget.value })}
            className="h-7 w-8 cursor-pointer rounded border border-stroke-soft-200 bg-bg-white-0"
          />
        </label>
      </div>

      {/* The windowed grid. */}
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-stroke-soft-200 bg-bg-white-0">
        <table className="border-collapse" style={{ tableLayout: "fixed" }}>
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-10 h-8 w-12 min-w-12 border-b border-r border-stroke-soft-200 bg-bg-weak-50" />
              {Array.from({ length: visibleCols }, (_, col) => (
                <th
                  key={col}
                  className="relative h-8 border-b border-r border-stroke-soft-200 bg-bg-weak-50 text-center font-mono text-label-xs text-text-soft-400"
                  style={{ width: columnWidth(sheet, col), minWidth: columnWidth(sheet, col) }}
                >
                  {columnLabel(col)}
                  {/* Column-width drag handle on the right edge. */}
                  <span
                    role="separator"
                    aria-label={`Resize column ${columnLabel(col)}`}
                    onPointerDown={(event) => startWidthDrag(event, col)}
                    className="absolute -right-1 top-0 z-20 h-full w-2 cursor-col-resize"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: visibleRows }, (_, row) => (
              <tr key={row}>
                <td className="sticky left-0 z-10 h-8 w-12 min-w-12 border-b border-r border-stroke-soft-200 bg-bg-weak-50 text-center align-middle font-mono text-label-xs text-text-soft-400">
                  {row + 1}
                </td>
                {Array.from({ length: visibleCols }, (_, col) => {
                  const ref = formatA1(row, col);
                  const evaluated = evaluation.cell(sheet.id, ref);
                  const isActive = row === selected.row && col === selected.col;
                  return (
                    <td
                      key={col}
                      className="border-b border-r border-stroke-soft-200 p-0"
                      style={{ width: columnWidth(sheet, col), minWidth: columnWidth(sheet, col) }}
                    >
                      <button
                        type="button"
                        onClick={() => setSelected({ row, col })}
                        onDoubleClick={() => barRef.current?.focus()}
                        title={evaluated.error ?? undefined}
                        style={cellStyle(sheet.cells[ref], evaluated.numeric)}
                        className={
                          isActive
                            ? "block h-8 w-full truncate px-2 text-paragraph-sm text-text-strong-950 outline-none ring-2 ring-inset ring-primary-base"
                            : "block h-8 w-full truncate px-2 text-paragraph-sm text-text-strong-950 outline-none hover:bg-bg-weak-50"
                        }
                      >
                        <span className={evaluated.error ? "text-error-base" : undefined}>
                          {evaluated.display}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            onChange(
              replaceSheet(
                workbook,
                grownDimensions(sheet, Math.min(SHEET_MAX_ROWS - 1, sheet.rowCount), sheet.colCount - 1),
              ),
            )}
          disabled={loading || sheet.rowCount >= SHEET_MAX_ROWS}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-3 text-label-sm hover:bg-bg-weak-50 disabled:opacity-40"
        >
          <RiAddLine aria-hidden className="size-4" /> Row
        </button>
        <button
          type="button"
          onClick={() =>
            onChange(
              replaceSheet(
                workbook,
                grownDimensions(sheet, sheet.rowCount - 1, Math.min(SHEET_MAX_COLS - 1, sheet.colCount)),
              ),
            )}
          disabled={loading || sheet.colCount >= SHEET_MAX_COLS}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-stroke-soft-200 px-3 text-label-sm hover:bg-bg-weak-50 disabled:opacity-40"
        >
          <RiAddLine aria-hidden className="size-4" /> Column
        </button>
        {capped && (
          <span className="text-paragraph-xs text-text-soft-400">
            Large sheet - showing the first {visibleRows} rows and {visibleCols} columns.
          </span>
        )}
      </div>

      {/* Sheet tabs: add / rename (double-click) / reorder / switch. */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {workbook.sheets.map((item) => {
          const active = item.id === workbook.activeSheetId;
          return (
            <div key={item.id} className="flex shrink-0 items-center">
              {renaming === item.id ? (
                <input
                  // biome-ignore lint/a11y/noAutofocus: focus the rename field the moment it opens.
                  autoFocus
                  defaultValue={item.name}
                  aria-label={`Rename ${item.name}`}
                  onBlur={(event) => {
                    onChange(renameSheet(workbook, item.id, event.currentTarget.value));
                    setRenaming(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      onChange(renameSheet(workbook, item.id, event.currentTarget.value));
                      setRenaming(null);
                    }
                    if (event.key === "Escape") setRenaming(null);
                  }}
                  className="h-7 w-28 rounded-lg border border-stroke-strong-950 bg-bg-white-0 px-2 text-label-xs text-text-strong-950 outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onChange({ ...workbook, activeSheetId: item.id })}
                  onDoubleClick={() => setRenaming(item.id)}
                  aria-current={active}
                  title={`${item.name} (double-click to rename)`}
                  className={
                    active
                      ? "inline-flex h-7 items-center rounded-lg border border-stroke-soft-200 bg-bg-strong-950 px-3 text-label-xs text-text-white-0"
                      : "inline-flex h-7 items-center rounded-lg border border-stroke-soft-200 bg-bg-weak-50 px-3 text-label-xs text-text-sub-600 hover:text-text-strong-950"
                  }
                >
                  {item.name}
                </button>
              )}
              {active && workbook.sheets.length > 1 && (
                <span className="ml-0.5 flex items-center">
                  <button
                    type="button"
                    onClick={() => onChange(moveSheet(workbook, item.id, -1))}
                    aria-label={`Move ${item.name} left`}
                    title="Move left"
                    className="grid size-6 place-items-center rounded text-text-soft-400 hover:bg-bg-weak-50 hover:text-text-strong-950"
                  >
                    <RiArrowLeftSLine aria-hidden className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange(moveSheet(workbook, item.id, 1))}
                    aria-label={`Move ${item.name} right`}
                    title="Move right"
                    className="grid size-6 place-items-center rounded text-text-soft-400 hover:bg-bg-weak-50 hover:text-text-strong-950"
                  >
                    <RiArrowRightSLine aria-hidden className="size-4" />
                  </button>
                </span>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => onChange(addSheet(workbook))}
          disabled={loading || workbook.sheets.length >= WORKBOOK_MAX_SHEETS}
          aria-label="Add sheet"
          title="Add sheet"
          className="grid size-7 shrink-0 place-items-center rounded-lg border border-stroke-soft-200 text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-40"
        >
          <RiAddLine aria-hidden className="size-4" />
        </button>
      </div>
    </section>
  );
}
