import { describe, expect, test } from "bun:test";
import { commandOptionId, commandSourceLabel, filterCommands, parseCommandIntent, slashInsertText, type SlashCommand } from "./slash-command";

// Phase 7: the picker labels its section by the ACTUAL provider source (not a guess) and wires
// stable option ids for aria-activedescendant.
describe("commandSourceLabel + commandOptionId (Phase 7 picker chrome)", () => {
  test("source label reflects the provider, defaulting to a neutral 'Commands'", () => {
    expect(commandSourceLabel("claude")).toBe("Claude commands");
    expect(commandSourceLabel("codex")).toBe("Codex commands");
    expect(commandSourceLabel("opencode")).toBe("OpenCode commands");
    expect(commandSourceLabel(undefined)).toBe("Commands");
    expect(commandSourceLabel("mystery")).toBe("Commands");
  });
  test("commandOptionId is stable + name-derived for aria-activedescendant", () => {
    expect(commandOptionId("review")).toBe("slashcmd-opt-review");
  });
});

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

// Phase 3: a picked/typed command becomes an EXPLICIT typed intent ONLY when its leading token
// is an advertised command; otherwise it stays an ordinary prompt (so raw slash text can't
// silently skip context). The backend re-validates the intent.
describe("parseCommandIntent (typed intent only for a known command)", () => {
  const cmds: SlashCommand[] = [{ name: "review", description: null }, { name: "status", description: null }];
  test("a known command with args -> {name, args} (args after the token)", () => {
    expect(parseCommandIntent("/review src/app.ts", cmds)).toEqual({ name: "review", args: "src/app.ts" });
  });
  test("a known command with NO args -> empty args", () => {
    expect(parseCommandIntent("/status", cmds)).toEqual({ name: "status", args: "" });
  });
  test("internal whitespace/unicode/multiline args are preserved", () => {
    expect(parseCommandIntent("/review a  b\nc 你好", cmds)).toEqual({ name: "review", args: "a  b\nc 你好" });
  });
  test("byte preservation: trailing whitespace/newlines in args survive (parsed from the RAW value)", () => {
    expect(parseCommandIntent("/review a  b  \nc  ", cmds)).toEqual({ name: "review", args: "a  b  \nc  " });
    expect(parseCommandIntent("/review \t x\t", cmds)).toEqual({ name: "review", args: "x\t" });
  });
  test("an UNKNOWN leading command -> null (stays an ordinary prompt, keeps context)", () => {
    expect(parseCommandIntent("/etc/passwd read this", cmds)).toBeNull();
    expect(parseCommandIntent("/notacommand", cmds)).toBeNull();
  });
  test("a mid-sentence slash or plain prose -> null", () => {
    expect(parseCommandIntent("run the /review command", cmds)).toBeNull();
    expect(parseCommandIntent("hello world", cmds)).toBeNull();
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
