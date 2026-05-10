import { describe, expect, test } from "bun:test";
import { filterCommands, slashInsertText, type SlashCommand } from "./slash-command";

// Slice 2/3 (+ review): a picked native command is inserted VERBATIM as `/name ` and sent to
// the resident session unchanged (no client-side rename/translation), and the "/" autocomplete
// filters prefix-first.
describe("slashInsertText (verbatim native command invocation)", () => {
  test("inserts exactly `/name ` (leading slash, trailing space for args)", () => {
    expect(slashInsertText("review")).toBe("/review ");
    expect(slashInsertText("deep-research")).toBe("/deep-research ");
  });
  test("does not rename, translate, or strip the name", () => {
    expect(slashInsertText("design-sync")).toBe("/design-sync ");
    expect(slashInsertText("mcp")).toBe("/mcp ");
  });
});

describe("filterCommands", () => {
  const cmds: SlashCommand[] = [
    { name: "review", description: null },
    { name: "reconcile", description: null },
    { name: "deep-research", description: null },
  ];
  test("prefix matches come before substring matches", () => {
    expect(filterCommands(cmds, "re").map((c) => c.name)).toEqual(["review", "reconcile", "deep-research"]);
  });
  test("substring-only match still surfaces", () => {
    expect(filterCommands(cmds, "search").map((c) => c.name)).toEqual(["deep-research"]);
  });
  test("caps the result count", () => {
    const many: SlashCommand[] = Array.from({ length: 20 }, (_, i) => ({ name: `cmd${i}`, description: null }));
    expect(filterCommands(many, "cmd", 8)).toHaveLength(8);
  });
});
