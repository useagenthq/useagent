// Pure diff builders for the agent-proposed-changes review. They turn a mainline
// workpiece state and a proposed state into a per-kind, render-ready diff model:
// a line diff for text-like companions (document / pdf text), changed cells for
// spreadsheets, and per-slide field changes for presentations. No React here so
// the logic is unit-tested directly.

import {
  parseA1,
  primaryHeadingBlock,
  workbookToCsv,
  type ArtifactWorkpieceKind,
  type ArtifactWorkpieceState,
  type DeckBlock,
  type DeckBlockType,
  type DeckSlide,
  type PresentationDeck,
  type SheetCell,
  type Workbook,
  type Worksheet,
} from "@useagent/artifact-workspace";
import type { DiffLine } from "@/components/session-ui/file-diff-view";

/** Above this line-product the O(m*n) LCS is skipped for a coarse block diff, so
 *  a pathological large-doc proposal never blocks the main thread (perf rule). */
const LCS_LINE_PRODUCT_BUDGET = 2_000_000;

function splitLines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
}

/** Line-level diff (LCS) into toned lines matching the session-ui diff grammar. */
export function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const m = a.length;
  const n = b.length;

  if (m * n > LCS_LINE_PRODUCT_BUDGET) {
    // Coarse fallback: show the whole replacement without the quadratic pass.
    return [
      { tone: "meta", text: "Large change - showing full replacement" },
      ...a.map((text): DiffLine => ({ tone: "del", text })),
      ...b.map((text): DiffLine => ({ tone: "add", text })),
    ];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ tone: "context", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ tone: "del", text: a[i]! });
      i++;
    } else {
      lines.push({ tone: "add", text: b[j]! });
      j++;
    }
  }
  while (i < m) lines.push({ tone: "del", text: a[i++]! });
  while (j < n) lines.push({ tone: "add", text: b[j++]! });
  return lines;
}

export function countLineChanges(lines: readonly DiffLine[]): {
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.tone === "add") additions++;
    else if (line.tone === "del") deletions++;
  }
  return { additions, deletions };
}

/** A1-style column name: 0 -> A, 25 -> Z, 26 -> AA. Re-exported from the shared
 * A1 helpers so the review and its tests share one implementation. */
export { columnLabel as columnName } from "@useagent/artifact-workspace";

export interface SheetCellChange {
  /** The worksheet name the cell lives on (workbooks are multi-sheet). */
  readonly sheet: string;
  readonly ref: string;
  readonly before: string;
  readonly after: string;
  readonly kind: "added" | "removed" | "changed";
  /** The cell's number format / styling changed (even if its value did not). */
  readonly formatChanged: boolean;
}

/** The raw display of a cell for the diff: its formula if any, else its value. */
function cellRaw(cell: SheetCell | undefined): string {
  if (!cell) return "";
  return cell.f ?? (typeof cell.v === "number" ? String(cell.v) : cell.v);
}

function fmtKey(cell: SheetCell | undefined): string {
  return cell?.fmt ? JSON.stringify(cell.fmt) : "";
}

/** Changed cells between two worksheets, in row-major A1 order. */
function worksheetCellChanges(
  name: string,
  before: Worksheet | null,
  after: Worksheet,
): SheetCellChange[] {
  const refs = new Set<string>([
    ...Object.keys(before?.cells ?? {}),
    ...Object.keys(after.cells),
  ]);
  const changes: SheetCellChange[] = [];
  for (const ref of refs) {
    const position = parseA1(ref);
    if (!position) continue;
    const beforeCell = before?.cells[ref];
    const afterCell = after.cells[ref];
    const beforeRaw = cellRaw(beforeCell);
    const afterRaw = cellRaw(afterCell);
    const valueChanged = beforeRaw !== afterRaw;
    const formatChanged = fmtKey(beforeCell) !== fmtKey(afterCell);
    if (!valueChanged && !formatChanged) continue;
    changes.push({
      sheet: name,
      ref,
      before: beforeRaw,
      after: afterRaw,
      kind: valueChanged
        ? beforeRaw === ""
          ? "added"
          : afterRaw === ""
          ? "removed"
          : "changed"
        : "changed",
      formatChanged,
    });
  }
  return changes.toSorted((a, b) => {
    const pa = parseA1(a.ref)!;
    const pb = parseA1(b.ref)!;
    return pa.row - pb.row || pa.col - pb.col;
  });
}

/** Changed cells across every worksheet of a workbook, matched by sheet id (a new
 * or removed sheet contributes all its cells). Row-major A1 order per sheet. */
export function workbookCellChanges(before: Workbook | null, after: Workbook): SheetCellChange[] {
  const beforeById = new Map((before?.sheets ?? []).map((sheet) => [sheet.id, sheet]));
  const changes: SheetCellChange[] = [];
  for (const sheet of after.sheets) {
    changes.push(...worksheetCellChanges(sheet.name, beforeById.get(sheet.id) ?? null, sheet));
  }
  // Removed sheets: every populated cell is a removal.
  const afterIds = new Set(after.sheets.map((sheet) => sheet.id));
  for (const sheet of before?.sheets ?? []) {
    if (afterIds.has(sheet.id)) continue;
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      changes.push({
        sheet: sheet.name,
        ref,
        before: cellRaw(cell),
        after: "",
        kind: "removed",
        formatChanged: false,
      });
    }
  }
  return changes;
}

export type DeckBlockChangeKind = "added" | "removed" | "moved" | "edited";

export interface DeckBlockChange {
  readonly id: string;
  readonly kind: DeckBlockChangeKind;
  readonly type: DeckBlockType;
  /** A short human label for the block (its text preview, or the block type). */
  readonly label: string;
}

export interface DeckSlideChange {
  readonly index: number;
  readonly kind: "added" | "removed" | "changed";
  readonly label: string;
  readonly blocks: readonly DeckBlockChange[];
  readonly backgroundChanged: boolean;
  readonly notesChanged: boolean;
}

function blockLabel(block: DeckBlock): string {
  if (block.type === "image") return "image";
  if (block.type === "shape") return "shape";
  const text = block.content.replace(/\s+/g, " ").trim();
  return text ? (text.length > 40 ? `${text.slice(0, 40)}...` : text) : block.type;
}

function slideLabel(slide: DeckSlide, index: number): string {
  return primaryHeadingBlock(slide)?.content?.trim() || `Slide ${index + 1}`;
}

function positionChanged(a: DeckBlock, b: DeckBlock): boolean {
  return a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h;
}

/** Block-level changes within one slide, matched by block id. */
function blockChanges(before: DeckSlide, after: DeckSlide): DeckBlockChange[] {
  const beforeById = new Map(before.blocks.map((block) => [block.id, block]));
  const afterById = new Map(after.blocks.map((block) => [block.id, block]));
  const changes: DeckBlockChange[] = [];
  for (const block of after.blocks) {
    const prior = beforeById.get(block.id);
    if (!prior) {
      changes.push({ id: block.id, kind: "added", type: block.type, label: blockLabel(block) });
      continue;
    }
    if (prior.content !== block.content || JSON.stringify(prior.style) !== JSON.stringify(block.style)) {
      changes.push({ id: block.id, kind: "edited", type: block.type, label: blockLabel(block) });
    } else if (positionChanged(prior, block)) {
      changes.push({ id: block.id, kind: "moved", type: block.type, label: blockLabel(block) });
    }
  }
  for (const block of before.blocks) {
    if (!afterById.has(block.id)) {
      changes.push({ id: block.id, kind: "removed", type: block.type, label: blockLabel(block) });
    }
  }
  return changes;
}

/** Per-slide deck changes (added / removed / changed) with block-level detail. */
export function deckSlideChanges(before: PresentationDeck, after: PresentationDeck): DeckSlideChange[] {
  const max = Math.max(before.slides.length, after.slides.length);
  const changes: DeckSlideChange[] = [];
  for (let index = 0; index < max; index++) {
    const b = before.slides[index];
    const a = after.slides[index];
    if (!b && a) {
      changes.push({
        index,
        kind: "added",
        label: slideLabel(a, index),
        blocks: a.blocks.map((block) => ({
          id: block.id,
          kind: "added" as const,
          type: block.type,
          label: blockLabel(block),
        })),
        backgroundChanged: !!a.background,
        notesChanged: !!a.notes,
      });
      continue;
    }
    if (b && !a) {
      changes.push({
        index,
        kind: "removed",
        label: slideLabel(b, index),
        blocks: b.blocks.map((block) => ({
          id: block.id,
          kind: "removed" as const,
          type: block.type,
          label: blockLabel(block),
        })),
        backgroundChanged: !!b.background,
        notesChanged: !!b.notes,
      });
      continue;
    }
    if (!a || !b) continue;
    const blocks = blockChanges(b, a);
    const backgroundChanged = JSON.stringify(b.background) !== JSON.stringify(a.background);
    const notesChanged = (b.notes ?? "") !== (a.notes ?? "");
    if (blocks.length > 0 || backgroundChanged || notesChanged) {
      changes.push({ index, kind: "changed", label: slideLabel(a, index), blocks, backgroundChanged, notesChanged });
    }
  }
  return changes;
}

/** Canonical text form of a text-like state (document / pdf), for the line diff. */
function stateText(state: ArtifactWorkpieceState | null): string {
  if (!state) return "";
  if ("document" in state) return state.document.html;
  if ("pdfText" in state) return state.pdfText;
  if ("text" in state) return state.text;
  if ("workbook" in state) return workbookToCsv(state.workbook);
  return "";
}

/** The document theme of a state, or null (a plain-text source doc / non-document). */
function documentTheme(state: ArtifactWorkpieceState | null): string | null {
  return state && "document" in state ? JSON.stringify(state.document.theme) : null;
}

export interface TextProposalDiff {
  readonly type: "text";
  readonly lines: DiffLine[];
  readonly additions: number;
  readonly deletions: number;
  /** The document theme (background/colors) changed between mainline and proposed. */
  readonly themeChanged: boolean;
  readonly unchanged: boolean;
}
export interface SheetProposalDiff {
  readonly type: "sheet";
  readonly cells: SheetCellChange[];
  readonly unchanged: boolean;
}
export interface SlidesProposalDiff {
  readonly type: "slides";
  readonly slides: DeckSlideChange[];
  /** The deck theme (background/colors) changed between mainline and proposed. */
  readonly themeChanged: boolean;
  readonly unchanged: boolean;
}
export type WorkpieceProposalDiff = TextProposalDiff | SheetProposalDiff | SlidesProposalDiff;

/** Build the render-ready diff model for a proposal against current mainline. */
export function workpieceProposalDiff(
  kind: ArtifactWorkpieceKind,
  mainline: ArtifactWorkpieceState | null,
  proposed: ArtifactWorkpieceState,
): WorkpieceProposalDiff {
  if (kind === "spreadsheet") {
    const beforeWorkbook = mainline && "workbook" in mainline ? mainline.workbook : null;
    const afterWorkbook = "workbook" in proposed ? proposed.workbook : null;
    if (!afterWorkbook) return { type: "sheet", cells: [], unchanged: true };
    const cells = workbookCellChanges(beforeWorkbook, afterWorkbook);
    return { type: "sheet", cells, unchanged: cells.length === 0 };
  }
  if (kind === "presentation") {
    const beforeDeck = mainline && "deck" in mainline ? mainline.deck : null;
    const afterDeck = "deck" in proposed ? proposed.deck : null;
    if (!afterDeck) return { type: "slides", slides: [], themeChanged: false, unchanged: true };
    // A brand-new deck (no mainline) diffs against an empty deck of the same theme.
    const baseline: PresentationDeck = beforeDeck ??
      { schemaVersion: afterDeck.schemaVersion, theme: afterDeck.theme, slides: [] };
    const slides = deckSlideChanges(baseline, afterDeck);
    const themeChanged = !!beforeDeck &&
      JSON.stringify(beforeDeck.theme) !== JSON.stringify(afterDeck.theme);
    return { type: "slides", slides, themeChanged, unchanged: slides.length === 0 && !themeChanged };
  }
  const lines = computeLineDiff(stateText(mainline), stateText(proposed));
  const { additions, deletions } = countLineChanges(lines);
  // A themed document can change only its theme (background/colors) with no body
  // edit; surface that as a change so an accept is never mislabelled "no change".
  const beforeTheme = documentTheme(mainline);
  const themeChanged = kind === "document" && beforeTheme !== null &&
    beforeTheme !== documentTheme(proposed);
  return {
    type: "text",
    lines,
    additions,
    deletions,
    themeChanged,
    unchanged: additions === 0 && deletions === 0 && !themeChanged,
  };
}

/** Read-only canonical text for the "View proposed" panel (all kinds). */
export function proposedPreviewText(state: ArtifactWorkpieceState): string {
  if ("workbook" in state) {
    const names = state.workbook.sheets.map((sheet) => sheet.name).join(", ");
    return `Sheets: ${names}\n\n${workbookToCsv(state.workbook)}`;
  }
  if ("deck" in state) {
    return state.deck.slides
      .map((slide, index) => {
        const text = slide.blocks
          .filter((block) => block.type === "heading" || block.type === "text")
          .map((block) => block.content)
          .filter(Boolean)
          .join("\n");
        const notes = slide.notes ? `\nNotes: ${slide.notes}` : "";
        return `Slide ${index + 1}:\n${text}${notes}`;
      })
      .join("\n\n");
  }
  return stateText(state);
}
