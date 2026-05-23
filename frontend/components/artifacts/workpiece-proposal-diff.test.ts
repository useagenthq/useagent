import { describe, expect, test } from "bun:test";
import {
  csvToWorkbook,
  DECK_THEME_PRESETS,
  migrateSlidesToDeck,
  type Workbook,
} from "@skynet/artifact-workspace";
import {
  columnName,
  computeLineDiff,
  countLineChanges,
  deckSlideChanges,
  proposedPreviewText,
  workbookCellChanges,
  workpieceProposalDiff,
} from "./workpiece-proposal-diff";

const emptyDeck = (theme = DECK_THEME_PRESETS[0]!.theme) =>
  ({ schemaVersion: 2 as const, theme, slides: [] });

describe("computeLineDiff", () => {
  test("all-context when nothing changed", () => {
    const lines = computeLineDiff("a\nb", "a\nb");
    expect(lines.every((line) => line.tone === "context")).toBe(true);
    expect(countLineChanges(lines)).toEqual({ additions: 0, deletions: 0 });
  });

  test("keeps surrounding context and marks the changed line", () => {
    const lines = computeLineDiff("a\nb\nc", "a\nB\nc");
    expect(lines[0]).toEqual({ tone: "context", text: "a" });
    expect(lines[lines.length - 1]).toEqual({ tone: "context", text: "c" });
    expect(lines.some((line) => line.tone === "del" && line.text === "b")).toBe(true);
    expect(lines.some((line) => line.tone === "add" && line.text === "B")).toBe(true);
    expect(countLineChanges(lines)).toEqual({ additions: 1, deletions: 1 });
  });

  test("a pure append is all additions after the shared prefix", () => {
    const lines = computeLineDiff("a", "a\nb");
    expect(lines).toEqual([
      { tone: "context", text: "a" },
      { tone: "add", text: "b" },
    ]);
  });
});

describe("columnName", () => {
  test("maps zero-based indices to A1 columns", () => {
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
  });
});

describe("workbookCellChanges", () => {
  test("reports a changed cell old -> new with its A1 ref and sheet", () => {
    expect(workbookCellChanges(csvToWorkbook("a,b\n1,2"), csvToWorkbook("a,X\n1,2"))).toEqual([
      { sheet: "Sheet 1", ref: "B1", before: "b", after: "X", kind: "changed", formatChanged: false },
    ]);
  });

  test("classifies added and removed cells", () => {
    expect(workbookCellChanges(csvToWorkbook("a"), csvToWorkbook("a,b"))).toEqual([
      { sheet: "Sheet 1", ref: "B1", before: "", after: "b", kind: "added", formatChanged: false },
    ]);
    expect(workbookCellChanges(csvToWorkbook("a,b"), csvToWorkbook("a"))).toEqual([
      { sheet: "Sheet 1", ref: "B1", before: "b", after: "", kind: "removed", formatChanged: false },
    ]);
  });

  test("reports a pure format change and a formula's raw text", () => {
    const base = csvToWorkbook("a\n1");
    const formatted: Workbook = {
      ...base,
      sheets: [{ ...base.sheets[0]!, cells: { ...base.sheets[0]!.cells, A1: { v: "a", fmt: { bold: true } } } }],
    };
    const [fmtChange] = workbookCellChanges(base, formatted);
    expect(fmtChange).toMatchObject({ ref: "A1", kind: "changed", formatChanged: true, before: "a", after: "a" });

    const withFormula: Workbook = {
      ...base,
      sheets: [{ ...base.sheets[0]!, cells: { ...base.sheets[0]!.cells, A3: { v: 1, f: "=SUM(A2:A2)" } } }],
    };
    const [formulaChange] = workbookCellChanges(base, withFormula);
    expect(formulaChange).toMatchObject({ ref: "A3", after: "=SUM(A2:A2)", kind: "added" });
  });
});

describe("deckSlideChanges", () => {
  test("reports an edited heading block on an existing slide (matched by id)", () => {
    const before = migrateSlidesToDeck([{ title: "T", body: "B" }]);
    const after = migrateSlidesToDeck([{ title: "T2", body: "B" }]);
    const changes = deckSlideChanges(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ index: 0, kind: "changed", label: "T2" });
    expect(changes[0]!.blocks.some((block) => block.kind === "edited" && block.type === "heading"))
      .toBe(true);
    // The unchanged body block is not reported.
    expect(changes[0]!.blocks.some((block) => block.type === "text")).toBe(false);
  });

  test("classifies a pure position change as a moved block", () => {
    const before = migrateSlidesToDeck([{ title: "T", body: "B" }]);
    const after = {
      ...before,
      slides: [{
        ...before.slides[0]!,
        blocks: before.slides[0]!.blocks.map((block) =>
          block.type === "heading" ? { ...block, x: block.x + 10 } : block
        ),
      }],
    };
    const [change] = deckSlideChanges(before, after);
    expect(change!.blocks[0]).toMatchObject({ kind: "moved", type: "heading" });
  });

  test("reports added and removed slides", () => {
    const one = migrateSlidesToDeck([{ title: "New", body: "" }]);
    expect(deckSlideChanges(emptyDeck(), one)[0]).toMatchObject({
      index: 0,
      kind: "added",
      label: "New",
    });
    expect(deckSlideChanges(one, emptyDeck())[0]).toMatchObject({
      index: 0,
      kind: "removed",
      label: "New",
    });
  });
});

describe("workpieceProposalDiff", () => {
  test("builds a text line diff for documents", () => {
    const diff = workpieceProposalDiff("document", { text: "a\nb" }, { text: "a\nc" });
    expect(diff.type).toBe("text");
    expect(diff.unchanged).toBe(false);
    if (diff.type === "text") {
      expect(diff.lines.some((line) => line.tone === "add" && line.text === "c")).toBe(true);
    }
  });

  test("flags an identical proposal as unchanged", () => {
    const diff = workpieceProposalDiff("document", { text: "same" }, { text: "same" });
    expect(diff.unchanged).toBe(true);
  });

  test("builds cell changes for spreadsheets and slide changes for presentations", () => {
    const sheet = workpieceProposalDiff(
      "spreadsheet",
      { workbook: csvToWorkbook("a,b") },
      { workbook: csvToWorkbook("a,c") },
    );
    expect(sheet).toMatchObject({
      type: "sheet",
      cells: [{ ref: "B1", before: "b", after: "c", kind: "changed" }],
    });

    const slides = workpieceProposalDiff(
      "presentation",
      { deck: migrateSlidesToDeck([{ title: "T", body: "" }]) },
      { deck: migrateSlidesToDeck([{ title: "T2", body: "" }]) },
    );
    expect(slides.type).toBe("slides");
    if (slides.type === "slides") {
      expect(slides.unchanged).toBe(false);
      expect(slides.slides[0]).toMatchObject({ kind: "changed" });
    }
  });

  test("flags a deck theme change even when slides are identical", () => {
    const diff = workpieceProposalDiff(
      "presentation",
      { deck: migrateSlidesToDeck([{ title: "T", body: "" }], DECK_THEME_PRESETS[0]!.theme) },
      { deck: migrateSlidesToDeck([{ title: "T", body: "" }], DECK_THEME_PRESETS[1]!.theme) },
    );
    expect(diff.type).toBe("slides");
    if (diff.type === "slides") {
      expect(diff.themeChanged).toBe(true);
      expect(diff.unchanged).toBe(false);
    }
  });
});

describe("proposedPreviewText", () => {
  test("passes text-like state through and formats a deck", () => {
    expect(proposedPreviewText({ text: "hello" })).toBe("hello");
    expect(
      proposedPreviewText({ deck: migrateSlidesToDeck([{ title: "T", body: "Body", notes: "N" }]) }),
    ).toBe("Slide 1:\nT\nBody\nNotes: N");
  });
});
