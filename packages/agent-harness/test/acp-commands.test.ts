import { describe, expect, test } from "bun:test";
import {
  ACP_COMMANDS_EVENT_TYPE,
  normalizeOpencodeCommands,
  parseAcpAvailableCommands,
  parseAcpCommandsFrame,
} from "../src/canonical";
import { translateOpenCode, type OpenCodeFrame } from "../src/opencode-canonical";

// Build a durable `acp.commands` provider-event frame (the shape acp-server records).
function cmdFrame(over: {
  eventId: string; seq: number; provider: string; sessionId: string; commands: unknown; source?: string; generation?: number;
}): OpenCodeFrame {
  return {
    eventId: over.eventId,
    seq: over.seq,
    provider: over.provider,
    eventType: ACP_COMMANDS_EVENT_TYPE,
    native: { sessionId: over.sessionId, parentSessionId: null, messageId: null, partId: null, callId: null },
    payload: {
      source: over.source ?? over.provider,
      commands: over.commands,
      ...(over.generation != null ? { generation: over.generation } : {}),
    },
  };
}
const CTX = { runId: "r", threadId: "t", engine: "claude" };
const commandsEvents = (frames: OpenCodeFrame[]) =>
  translateOpenCode(frames, CTX, []).events.filter((e) => e.kind === "commands.updated");

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
  test("OpenCode + ACP normalize to IDENTICAL shape (one shared normalization)", () => {
    const raw = [{ name: "review", description: "Review", input: "[files]" }, { name: "review" }];
    expect(normalizeOpencodeCommands(raw)).toEqual(parseAcpAvailableCommands({ availableCommands: raw }));
  });
});

describe("parseAcpCommandsFrame (durable provider-event payload -> catalog + provenance)", () => {
  test("parses commands + source + generation; re-normalizes (dedupe/trim)", () => {
    expect(
      parseAcpCommandsFrame({ source: "claude", generation: 3, commands: [{ name: " a " }, { name: "a" }, { name: "b", input: "<x>" }] }),
    ).toEqual({ catalog: [{ name: "a" }, { name: "b", input: "<x>" }], source: "claude", generation: 3 });
  });
  test("an EMPTY commands array is a valid empty replacement (catalog []), NOT null", () => {
    expect(parseAcpCommandsFrame({ source: "codex", commands: [] })).toEqual({ catalog: [], source: "codex" });
  });
  test("a payload with no commands array -> null (unparseable)", () => {
    expect(parseAcpCommandsFrame({ source: "claude" })).toBeNull();
    expect(parseAcpCommandsFrame(null)).toBeNull();
    expect(parseAcpCommandsFrame("nope")).toBeNull();
  });
});

describe("translateOpenCode: acp.commands frame -> session-identified commands.updated", () => {
  test("emits commands.updated with catalog, source label, and native session identity", () => {
    const [e] = commandsEvents([
      cmdFrame({ eventId: "s1:commands", seq: 0, provider: "claude", sessionId: "s1", generation: 2, commands: [{ name: "review", description: "Review", input: "[files]" }, { name: "compact" }] }),
    ]);
    expect(e?.kind).toBe("commands.updated");
    expect(e?.identity.nativeSessionId).toBe("s1");
    if (e?.kind === "commands.updated") {
      expect(e.commands).toEqual(["review", "compact"]);
      expect(e.catalog).toEqual([{ name: "review", description: "Review", input: "[files]" }, { name: "compact" }]);
      expect(e.source).toBe("claude");
      expect(e.generation).toBe(2);
    }
  });

  test("an EMPTY replacement frame emits an EMPTY commands.updated (honored, not dropped)", () => {
    const [e] = commandsEvents([cmdFrame({ eventId: "s1:commands", seq: 0, provider: "codex", sessionId: "s1", commands: [] })]);
    expect(e?.kind).toBe("commands.updated");
    if (e?.kind === "commands.updated") expect(e.commands).toEqual([]);
  });

  test("TWO native sessions in one thread keep DISTINCT session-identified catalogs", () => {
    const evs = commandsEvents([
      cmdFrame({ eventId: "s1:commands", seq: 0, provider: "claude", sessionId: "s1", commands: [{ name: "a" }] }),
      cmdFrame({ eventId: "s2:commands", seq: 1, provider: "claude", sessionId: "s2", commands: [{ name: "b" }] }),
    ]);
    expect(evs.map((e) => e.identity.nativeSessionId)).toEqual(["s1", "s2"]);
    expect(evs.map((e) => (e.kind === "commands.updated" ? e.commands : []))).toEqual([["a"], ["b"]]);
  });

  test("a non-command frame is unaffected; a plain OpenCode run emits NO commands.updated", () => {
    const evs = commandsEvents([
      { eventId: "x", seq: 0, provider: "opencode", eventType: "part.text", native: { sessionId: "s", parentSessionId: null, messageId: "m", partId: "p", callId: null }, payload: { text: "hi" } },
    ]);
    expect(evs).toHaveLength(0);
  });

  test("an unparseable acp.commands frame does not warn or emit (suppressed)", () => {
    const { events } = translateOpenCode(
      [{ eventId: "s1:commands", seq: 0, provider: "claude", eventType: ACP_COMMANDS_EVENT_TYPE, native: { sessionId: "s1", parentSessionId: null, messageId: null, partId: null, callId: null }, payload: { source: "claude" } }],
      CTX,
      [],
    );
    expect(events.filter((e) => e.kind === "commands.updated")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "harness.warning")).toHaveLength(0);
  });
});
