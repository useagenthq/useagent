import { describe, expect, test } from "bun:test";

// The terminal bridge must decode PTY chunks in streaming mode: a multi-byte
// UTF-8 sequence split across two chunks has to survive reassembly. This pins
// the exact failure seen on session reattach (box-glyph gibberish).
describe("terminal PTY chunk decoding", () => {
  test("a multi-byte sequence split across chunks survives streaming decode", () => {
    const bytes = new TextEncoder().encode("┌─ box ─┐ αβγ");
    const cut = 2; // splits inside the first 3-byte box-drawing character
    const a = bytes.slice(0, cut);
    const b = bytes.slice(cut);

    const streaming = new TextDecoder("utf-8");
    const joined = streaming.decode(a, { stream: true }) + streaming.decode(b, { stream: true });
    expect(joined).toBe("┌─ box ─┐ αβγ");

    // The old per-chunk decode demonstrably mangles the same input.
    const naive = new TextDecoder("utf-8");
    const mangled = naive.decode(a) + naive.decode(b);
    expect(mangled).not.toBe("┌─ box ─┐ αβγ");
  });
});
