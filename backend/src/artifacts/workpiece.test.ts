import { describe, expect, test } from "bun:test";
import {
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
});
