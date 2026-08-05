import { describe, expect, it } from "bun:test";
import {
  chunkText,
  dispatch,
  type OutputEvent,
  type Renderer,
} from "./types";

/** A recording Renderer — captures every callback in order for assertions. */
function recordingRenderer(): {
  renderer: Renderer;
  calls: Array<[string, ...unknown[]]>;
} {
  const calls: Array<[string, ...unknown[]]> = [];
  const renderer: Renderer = {
    channelType: "test",
    onTextChunk: (t) => void calls.push(["onTextChunk", t]),
    onThinking: (t) => void calls.push(["onThinking", t]),
    onToolCall: (id, title, kind, purpose) =>
      void calls.push(["onToolCall", id, title, kind, purpose]),
    onCompaction: (pct) => void calls.push(["onCompaction", pct]),
    onDone: (reason) => void calls.push(["onDone", reason]),
  };
  return { renderer, calls };
}

describe("dispatch — renderer event mapping", () => {
  it("routes each output kind to its matching on* handler", async () => {
    const { renderer, calls } = recordingRenderer();
    const events: OutputEvent[] = [
      { kind: "text_chunk", text: "hello" },
      { kind: "thinking", text: "pondering" },
      {
        kind: "tool_call",
        toolCallId: "t1",
        title: "Editing file",
        toolKind: "edit",
        toolPurpose: "file",
      },
      { kind: "compaction", contextUsagePct: 42 },
      { kind: "done", stopReason: "completed" },
    ];
    for (const e of events) await dispatch(renderer, e);

    expect(calls).toEqual([
      ["onTextChunk", "hello"],
      ["onThinking", "pondering"],
      ["onToolCall", "t1", "Editing file", "edit", "file"],
      ["onCompaction", 42],
      ["onDone", "completed"],
    ]);
  });

  it("fills sensible defaults for absent fields", async () => {
    const { renderer, calls } = recordingRenderer();
    await dispatch(renderer, { kind: "tool_call" });
    await dispatch(renderer, { kind: "done" });
    expect(calls).toEqual([
      ["onToolCall", "", "", "", ""],
      ["onDone", ""],
    ]);
  });

  it("throws on an unknown event kind", async () => {
    const { renderer } = recordingRenderer();
    await expect(
      dispatch(renderer, { kind: "bogus" as OutputEvent["kind"] }),
    ).rejects.toThrow(/unknown output event kind/);
  });
});

describe("chunkText", () => {
  it("returns [] for empty input", () => {
    expect(chunkText("", 10)).toEqual([]);
  });
  it("returns a single chunk when under the cap or cap<=0", () => {
    expect(chunkText("abc", 10)).toEqual(["abc"]);
    expect(chunkText("abcdef", 0)).toEqual(["abcdef"]);
  });
  it("splits into cap-sized chunks", () => {
    expect(chunkText("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });
});
