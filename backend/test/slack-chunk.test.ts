import { describe, expect, test } from "bun:test";
import { chunkSlackText, SLACK_MSG_LIMIT } from "../src/slack/chunk";

// Reply chunking (ported from KiroCrew's split_message, src/kiro_crew/slack/format.py:361): long
// replies become sequential thread messages cut on paragraph/code-fence
// boundaries, each within the 3,900-char bound, code blocks kept renderable.

describe("chunkSlackText", () => {
  test("a short text passes through untouched as a single chunk", () => {
    const text = "hello *world*\n\nsecond paragraph";
    expect(chunkSlackText(text)).toEqual([text]);
  });

  test("every chunk respects the per-message bound", () => {
    const text = Array.from({ length: 80 }, (_, i) => `p${i} ${"a".repeat(150)}`).join("\n\n");
    const chunks = chunkSlackText(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SLACK_MSG_LIMIT);
  });

  test("cuts land on paragraph boundaries and mark continuations", () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `paragraph-${i} ${"b".repeat(200)}`);
    const chunks = chunkSlackText(paragraphs.join("\n\n"));
    // Non-final chunks carry the continuation marker; no paragraph is split.
    for (const c of chunks.slice(0, -1)) expect(c.endsWith("_(continued…)_")).toBe(true);
    const rejoined = chunks.map((c) => c.replace(/\n\n_\(continued…\)_$/, "")).join("\n\n");
    for (const p of paragraphs) expect(rejoined).toContain(p);
  });

  test("a fenced code block that fits is never split across chunks", () => {
    const fence = "```ts\n" + Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n```";
    const padding = Array.from({ length: 30 }, (_, i) => `pad-${i} ${"c".repeat(180)}`).join("\n\n");
    const chunks = chunkSlackText(`${padding}\n\n${fence}\n\n${padding}`);
    const holder = chunks.filter((c) => c.includes("const x0 ="));
    expect(holder).toHaveLength(1);
    expect(holder[0]).toContain("const x19 =");
  });

  test("an oversized code block splits into VALID fences, language preserved", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: ${"d".repeat(40)}`);
    const chunks = chunkSlackText("intro\n\n```python\n" + lines.join("\n") + "\n```\n\noutro");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(SLACK_MSG_LIMIT);
      // Balanced fences in every chunk: each ```python opener has its closer.
      const fenceLines = c.split("\n").filter((l) => l.startsWith("```"));
      expect(fenceLines.length % 2).toBe(0);
    }
    const withCode = chunks.filter((c) => c.includes("```python"));
    expect(withCode.length).toBeGreaterThan(1); // reopened with the language tag
    const rejoined = chunks.join("\n");
    expect(rejoined).toContain("line 0:");
    expect(rejoined).toContain("line 199:");
  });

  test("a giant unbroken line (no newlines at all) still terminates and bounds", () => {
    const chunks = chunkSlackText("z".repeat(20_000));
    expect(chunks.length).toBeGreaterThan(4);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SLACK_MSG_LIMIT);
    expect(chunks.map((c) => c.replace(/\n\n_\(continued…\)_$/, "")).join("")).toBe("z".repeat(20_000));
  });

  test("an unclosed fence is closed rather than leaking into the next chunk", () => {
    const chunks = chunkSlackText("before\n\n```\n" + Array.from({ length: 900 }, (_, i) => `raw line ${i}`).join("\n"));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const fenceLines = c.split("\n").filter((l) => l.startsWith("```"));
      expect(fenceLines.length % 2).toBe(0);
    }
  });

  test("a hard cut inside an oversized line never splits a surrogate pair", () => {
    const line = `${"a".repeat(3_899)}😀${"b".repeat(50)}`;
    const chunks = chunkSlackText(line);
    expect(chunks.every((c) => c.isWellFormed())).toBe(true);
    expect(chunks.map((c) => c.replace(/\n\n_\(continued…\)_$/, "")).join("")).toBe(line);
  });

  test("a fence whose language tag eats the whole budget still makes progress on an emoji body", () => {
    const block = "```" + "x".repeat(3_900) + "\n😀\n```";
    const chunks = chunkSlackText(block);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.isWellFormed())).toBe(true);
    expect(chunks.join("")).toContain("😀");
  });

  test("an oversized language tag is cut so every piece stays within the bound", () => {
    for (const tag of [3_900, 5_000]) {
      const chunks = chunkSlackText("```" + "x".repeat(tag) + "\n" + "😀".repeat(3_000) + "\n```");
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SLACK_MSG_LIMIT);
      expect(chunks.every((c) => c.isWellFormed())).toBe(true);
      expect(chunks.join("")).toContain("😀");
    }
  });
});
