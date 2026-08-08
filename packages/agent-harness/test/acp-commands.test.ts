import { describe, expect, test } from "bun:test";
import { normalizeOpencodeCommands, parseAcpAvailableCommands } from "../src/canonical";

// Slice 2: native command discovery. `available_commands_update` is a REPLACEMENT snapshot
// for the provider session; OpenCode's `/command` normalizes into the SAME shape so one
// product command surface serves every engine.
describe("parseAcpAvailableCommands (ACP available_commands_update -> canonical snapshot)", () => {
  test("parses name + description + input hint (object or string form)", () => {
    const out = parseAcpAvailableCommands({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "review", description: "Review the diff", input: { hint: "[files]" } },
        { name: "status", description: "Show status" },
        { name: "run", input: "<cmd>" },
      ],
    });
    expect(out).toEqual([
      { name: "review", description: "Review the diff", input: "[files]" },
      { name: "status", description: "Show status" },
      { name: "run", input: "<cmd>" },
    ]);
  });

  test("REPLACEMENT semantics: an empty availableCommands is an empty snapshot (not 'keep old')", () => {
    expect(parseAcpAvailableCommands({ availableCommands: [] })).toEqual([]);
  });

  test("nameless / blank-name entries drop; duplicates keep the first", () => {
    const out = parseAcpAvailableCommands({
      availableCommands: [{ description: "no name" }, { name: "" }, { name: "dup" }, { name: "dup", description: "second" }],
    });
    expect(out).toEqual([{ name: "dup" }]);
  });

  test("a malformed (non-array) frame yields an empty snapshot, never throws", () => {
    expect(parseAcpAvailableCommands({})).toEqual([]);
    expect(parseAcpAvailableCommands({ availableCommands: "nope" })).toEqual([]);
    expect(parseAcpAvailableCommands({ availableCommands: null })).toEqual([]);
  });

  test("names are trimmed", () => {
    expect(parseAcpAvailableCommands({ availableCommands: [{ name: "  init  " }] })).toEqual([{ name: "init" }]);
  });
});

describe("normalizeOpencodeCommands (OpenCode /command -> same canonical shape)", () => {
  test("normalizes {name, description}[] and dedupes", () => {
    const out = normalizeOpencodeCommands([{ name: "init", description: "d" }, { name: "init" }, { bad: true }]);
    expect(out).toEqual([{ name: "init", description: "d" }]);
  });
  test("a non-array yields empty", () => {
    expect(normalizeOpencodeCommands("x")).toEqual([]);
  });
});
