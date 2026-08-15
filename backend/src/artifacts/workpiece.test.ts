import { describe, expect, test } from "bun:test";
import {
  buildInitialWorkpieceState,
  inferWorkpieceKind,
  MAX_RICH_WORKPIECE_SOURCE_BYTES,
  parseWorkpieceState,
} from "./workpiece";

describe("artifact workpiece registry", () => {
  test("recognizes bounded Office companions without enabling arbitrary binaries", () => {
    expect(inferWorkpieceKind(
      "brief.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      MAX_RICH_WORKPIECE_SOURCE_BYTES,
    )).toBe("document");
    expect(inferWorkpieceKind(
      "model.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      MAX_RICH_WORKPIECE_SOURCE_BYTES,
    )).toBe("spreadsheet");
    expect(inferWorkpieceKind("archive.zip", "application/zip", 42)).toBeNull();
  });

  test("keeps over-limit Office binaries download-only", () => {
    expect(inferWorkpieceKind(
      "huge.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      MAX_RICH_WORKPIECE_SOURCE_BYTES + 1,
    )).toBeNull();
    expect(inferWorkpieceKind(
      "huge.bin",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      MAX_RICH_WORKPIECE_SOURCE_BYTES + 1,
    )).toBeNull();
  });

  test("accepts only bounded state shapes and rejects active rich HTML", () => {
    expect(parseWorkpieceState("document", { html: "<h1>Brief</h1><p>Safe</p>" })).toEqual({
      html: "<h1>Brief</h1><p>Safe</p>",
    });
    expect(parseWorkpieceState("document", { html: "<img src=x onerror=alert(1)>" })).toBeNull();
    expect(parseWorkpieceState("document", {
      html: '<a href="jav&#x61;script:alert(1)">click</a>',
    })).toBeNull();
    expect(parseWorkpieceState("document", { html: "<scr&#x69;pt>alert(1)</script>" })).toBeNull();
    expect(parseWorkpieceState("document", {
      html: '<table><tbody><tr><td colspan="2">Safe</td></tr></tbody></table>',
    })).not.toBeNull();
    expect(parseWorkpieceState("document", {
      html: '<a href="https://example.com/?a=1&amp;b=2">Safe link</a>',
    })).not.toBeNull();
    expect(parseWorkpieceState("document", { text: "plain" })).toEqual({ text: "plain" });
    expect(parseWorkpieceState("spreadsheet", { csv: "name,value\nrun,42" })).toEqual({
      csv: "name,value\nrun,42",
    });
    expect(parseWorkpieceState("spreadsheet", { html: "<p>wrong</p>" })).toBeNull();
  });

  test("seeds editable text and CSV sources without a companion file", () => {
    expect(buildInitialWorkpieceState({
      kind: "document",
      sourceName: "notes.md",
      sourceBytes: Buffer.from("# Notes"),
    })).toEqual({ text: "# Notes" });
    expect(buildInitialWorkpieceState({
      kind: "spreadsheet",
      sourceName: "metrics.csv",
      sourceBytes: Buffer.from("name,value\nlatency,42"),
    })).toEqual({ csv: "name,value\nlatency,42" });
  });

  test("seeds Office workpieces only from a matching validated companion", () => {
    expect(buildInitialWorkpieceState({
      kind: "document",
      sourceName: "brief.docx",
      sourceBytes: Buffer.from("zip"),
      editable: { name: "brief.html", bytes: Buffer.from("<h1>Brief</h1>") },
    })).toEqual({ html: "<h1>Brief</h1>" });
    expect(buildInitialWorkpieceState({
      kind: "spreadsheet",
      sourceName: "model.xlsx",
      sourceBytes: Buffer.from("zip"),
      editable: { name: "model.csv", bytes: Buffer.from("name,value\nrun,42") },
    })).toEqual({ csv: "name,value\nrun,42" });
    expect(buildInitialWorkpieceState({
      kind: "document",
      sourceName: "brief.docx",
      sourceBytes: Buffer.from("zip"),
      editable: { name: "brief.html", bytes: Buffer.from("<script>alert(1)</script>") },
    })).toBeNull();
    expect(buildInitialWorkpieceState({
      kind: "spreadsheet",
      sourceName: "model.xlsx",
      sourceBytes: Buffer.from("zip"),
      editable: { name: "model.html", bytes: Buffer.from("<p>wrong</p>") },
    })).toBeNull();
  });
});
