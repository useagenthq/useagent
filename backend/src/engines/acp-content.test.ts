import { describe, expect, test } from "bun:test";
import { extractAcpToolOutput } from "./acp-content";

describe("extractAcpToolOutput", () => {
  test("normalizes Claude nested content blocks", () => {
    expect(
      extractAcpToolOutput(
        [
          { type: "content", content: { type: "text", text: "first" } },
          { type: "content", content: { type: "text", text: "second" } },
        ],
        undefined,
      ),
    ).toBe("first\nsecond");
  });

  test("normalizes direct ACP text blocks", () => {
    expect(extractAcpToolOutput([{ type: "text", text: "direct" }], null)).toBe(
      "direct",
    );
  });

  test("falls back to Codex rawOutput strings and objects", () => {
    expect(extractAcpToolOutput([], "FIRSTLINE: {")).toBe("FIRSTLINE: {");
    expect(extractAcpToolOutput(undefined, { exitCode: 0, output: "ok" })).toBe(
      '{"exitCode":0,"output":"ok"}',
    );
  });

  test("prefers structured content and applies the output bound", () => {
    expect(
      extractAcpToolOutput(
        [{ type: "content", content: { type: "text", text: "content" } }],
        "raw",
        4,
      ),
    ).toBe("cont");
  });
});
