import { describe, expect, test } from "bun:test";
import {
  columnName,
  computeLineDiff,
  countLineChanges,
  proposedPreviewText,
  sheetCellChanges,
  slideChanges,
  workpieceProposalDiff,
} from "./workpiece-proposal-diff";

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

describe("sheetCellChanges", () => {
  test("reports a changed cell old -> new with its A1 ref", () => {
    expect(sheetCellChanges("a,b\n1,2", "a,X\n1,2")).toEqual([
      { ref: "B1", before: "b", after: "X", kind: "changed" },
    ]);
  });

  test("classifies added and removed cells", () => {
    expect(sheetCellChanges("a", "a,b")).toEqual([
      { ref: "B1", before: "", after: "b", kind: "added" },
    ]);
    expect(sheetCellChanges("a,b", "a")).toEqual([
      { ref: "B1", before: "b", after: "", kind: "removed" },
    ]);
  });
});

describe("slideChanges", () => {
  test("reports a changed field on an existing slide", () => {
    const changes = slideChanges(
      [{ title: "T", body: "B", notes: "" }],
      [{ title: "T2", body: "B", notes: "" }],
    );
    expect(changes).toEqual([
      { index: 0, kind: "changed", label: "T2", fields: [{ field: "title", before: "T", after: "T2" }] },
    ]);
  });

  test("reports added and removed slides", () => {
    expect(slideChanges([], [{ title: "New", body: "", notes: "" }])[0]).toMatchObject({
      index: 0,
      kind: "added",
      label: "New",
    });
    expect(slideChanges([{ title: "Old", body: "", notes: "" }], [])[0]).toMatchObject({
      index: 0,
      kind: "removed",
      label: "Old",
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
    const sheet = workpieceProposalDiff("spreadsheet", { csv: "a,b" }, { csv: "a,c" });
    expect(sheet).toMatchObject({
      type: "sheet",
      cells: [{ ref: "B1", before: "b", after: "c", kind: "changed" }],
    });

    const slides = workpieceProposalDiff(
      "presentation",
      { slides: [{ title: "T", body: "", notes: "" }] },
      { slides: [{ title: "T2", body: "", notes: "" }] },
    );
    expect(slides.type).toBe("slides");
    if (slides.type === "slides") expect(slides.slides[0]).toMatchObject({ kind: "changed" });
  });
});

describe("proposedPreviewText", () => {
  test("passes text-like state through and formats slides", () => {
    expect(proposedPreviewText({ text: "hello" })).toBe("hello");
    expect(proposedPreviewText({ slides: [{ title: "T", body: "Body", notes: "N" }] })).toBe(
      "Slide 1: T\nBody\nNotes: N",
    );
  });
});
