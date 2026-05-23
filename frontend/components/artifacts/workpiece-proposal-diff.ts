// Pure diff builders for the agent-proposed-changes review. They turn a mainline
// workpiece state and a proposed state into a per-kind, render-ready diff model:
// a line diff for text-like companions (document / pdf text), changed cells for
// spreadsheets, and per-slide field changes for presentations. No React here so
// the logic is unit-tested directly.

import {
  parseArtifactCsv as parseCsv,
  type ArtifactPresentationSlide,
  type ArtifactWorkpieceKind,
  type ArtifactWorkpieceState,
} from "@skynet/artifact-workspace";
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

/** A1-style column name: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnName(index: number): string {
  let name = "";
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

export interface SheetCellChange {
  readonly ref: string;
  readonly before: string;
  readonly after: string;
  readonly kind: "added" | "removed" | "changed";
}

/** Changed cells (old -> new) between two CSV states, in row-major A1 order. */
export function sheetCellChanges(before: string, after: string): SheetCellChange[] {
  const a = parseCsv(before);
  const b = parseCsv(after);
  const rows = Math.max(a.length, b.length);
  const changes: SheetCellChange[] = [];
  for (let r = 0; r < rows; r++) {
    const rowA = a[r] ?? [];
    const rowB = b[r] ?? [];
    const cols = Math.max(rowA.length, rowB.length);
    for (let c = 0; c < cols; c++) {
      const beforeValue = rowA[c] ?? "";
      const afterValue = rowB[c] ?? "";
      if (beforeValue === afterValue) continue;
      changes.push({
        ref: `${columnName(c)}${r + 1}`,
        before: beforeValue,
        after: afterValue,
        kind: beforeValue === "" ? "added" : afterValue === "" ? "removed" : "changed",
      });
    }
  }
  return changes;
}

export type SlideField = "title" | "body" | "notes";

export interface SlideFieldChange {
  readonly field: SlideField;
  readonly before: string;
  readonly after: string;
}

export interface SlideChange {
  readonly index: number;
  readonly kind: "added" | "removed" | "changed";
  readonly label: string;
  readonly fields: readonly SlideFieldChange[];
}

const EMPTY_SLIDE: ArtifactPresentationSlide = { title: "", body: "", notes: "" };

function slideFieldChanges(
  before: ArtifactPresentationSlide,
  after: ArtifactPresentationSlide,
): SlideFieldChange[] {
  const fields: SlideField[] = ["title", "body", "notes"];
  return fields
    .map((field): SlideFieldChange => ({
      field,
      before: before[field] ?? "",
      after: after[field] ?? "",
    }))
    .filter((change) => change.before !== change.after);
}

/** Per-slide changes (added / removed / changed with the changed fields). */
export function slideChanges(
  before: readonly ArtifactPresentationSlide[],
  after: readonly ArtifactPresentationSlide[],
): SlideChange[] {
  const max = Math.max(before.length, after.length);
  const changes: SlideChange[] = [];
  for (let index = 0; index < max; index++) {
    const b = before[index];
    const a = after[index];
    if (!b && a) {
      changes.push({
        index,
        kind: "added",
        label: a.title || `Slide ${index + 1}`,
        fields: slideFieldChanges(EMPTY_SLIDE, a),
      });
      continue;
    }
    if (b && !a) {
      changes.push({
        index,
        kind: "removed",
        label: b.title || `Slide ${index + 1}`,
        fields: slideFieldChanges(b, EMPTY_SLIDE),
      });
      continue;
    }
    if (!a || !b) continue;
    const fields = slideFieldChanges(b, a);
    if (fields.length > 0) {
      changes.push({
        index,
        kind: "changed",
        label: a.title || b.title || `Slide ${index + 1}`,
        fields,
      });
    }
  }
  return changes;
}

/** Canonical text form of a text-like state (document / pdf), for the line diff. */
function stateText(state: ArtifactWorkpieceState | null): string {
  if (!state) return "";
  if ("html" in state) return state.html;
  if ("pdfText" in state) return state.pdfText;
  if ("text" in state) return state.text;
  if ("csv" in state) return state.csv;
  return "";
}

export interface TextProposalDiff {
  readonly type: "text";
  readonly lines: DiffLine[];
  readonly additions: number;
  readonly deletions: number;
  readonly unchanged: boolean;
}
export interface SheetProposalDiff {
  readonly type: "sheet";
  readonly cells: SheetCellChange[];
  readonly unchanged: boolean;
}
export interface SlidesProposalDiff {
  readonly type: "slides";
  readonly slides: SlideChange[];
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
    const cells = sheetCellChanges(
      mainline && "csv" in mainline ? mainline.csv : "",
      "csv" in proposed ? proposed.csv : "",
    );
    return { type: "sheet", cells, unchanged: cells.length === 0 };
  }
  if (kind === "presentation") {
    const before = mainline && "slides" in mainline ? mainline.slides : [];
    const after = "slides" in proposed ? proposed.slides : [];
    const slides = slideChanges(before, after);
    return { type: "slides", slides, unchanged: slides.length === 0 };
  }
  const lines = computeLineDiff(stateText(mainline), stateText(proposed));
  const { additions, deletions } = countLineChanges(lines);
  return {
    type: "text",
    lines,
    additions,
    deletions,
    unchanged: additions === 0 && deletions === 0,
  };
}

/** Read-only canonical text for the "View proposed" panel (all kinds). */
export function proposedPreviewText(state: ArtifactWorkpieceState): string {
  if ("slides" in state) {
    return state.slides
      .map((slide, index) => {
        const notes = slide.notes ? `\nNotes: ${slide.notes}` : "";
        return `Slide ${index + 1}: ${slide.title}\n${slide.body}${notes}`;
      })
      .join("\n\n");
  }
  return stateText(state);
}
