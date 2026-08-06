// Unit tests for the explicit-memory envelope (new_mem_prompt.md section 6):
// round-trip format/parse, multi-line content, rejection of non-envelopes and
// malformed blocks, and the identity-field guarantees. Pure - no DB/provider.
import { describe, expect, test } from "bun:test";
import {
  EXPLICIT_MEMORY_TAG,
  formatEnvelope,
  isExplicitMemory,
  parseEnvelope,
  type ExplicitMemoryEnvelope,
} from "./explicit-memory";

const base: ExplicitMemoryEnvelope = {
  logicalId: "11111111-1111-1111-1111-111111111111",
  operationId: "op-abc123",
  version: 1,
  kind: "preference",
  key: "favourite_color",
  state: "active",
  content: "The user's favourite color is blue.",
};

describe("formatEnvelope / parseEnvelope round-trip", () => {
  test("round-trips a full envelope", () => {
    const text = formatEnvelope(base);
    expect(text.startsWith(EXPLICIT_MEMORY_TAG)).toBe(true);
    expect(parseEnvelope(text)).toEqual(base);
  });

  test("round-trips without an optional key", () => {
    const { key: _k, ...noKey } = base;
    const env = { ...noKey, kind: "fact" as const, content: "Runs are event-sourced." };
    const text = formatEnvelope(env);
    expect(text).not.toContain("key:");
    expect(parseEnvelope(text)).toEqual(env);
  });

  test("preserves multi-line content", () => {
    const env = { ...base, content: "line one\nline two\nline three" };
    expect(parseEnvelope(formatEnvelope(env))?.content).toBe("line one\nline two\nline three");
  });
});

describe("isExplicitMemory", () => {
  test("true only for the tagged block", () => {
    expect(isExplicitMemory(formatEnvelope(base))).toBe(true);
    expect(isExplicitMemory("just a normal distilled memory about the user")).toBe(false);
    expect(isExplicitMemory("  \n" + EXPLICIT_MEMORY_TAG + "\n...")).toBe(true);
  });
});

describe("parseEnvelope rejects", () => {
  test("a non-envelope string", () => {
    expect(parseEnvelope("the user likes teal")).toBeNull();
  });

  test("a block missing required identity fields", () => {
    const partial = `${EXPLICIT_MEMORY_TAG}\nkind: preference\nstate: active\ncontent: x`;
    expect(parseEnvelope(partial)).toBeNull();
  });

  test("an invalid kind or state", () => {
    const badKind = formatEnvelope(base).replace("kind: preference", "kind: bogus");
    expect(parseEnvelope(badKind)).toBeNull();
    const badState = formatEnvelope(base).replace("state: active", "state: exploded");
    expect(parseEnvelope(badState)).toBeNull();
  });

  test("a non-positive version", () => {
    const bad = formatEnvelope({ ...base, version: 1 }).replace("version: 1", "version: 0");
    expect(parseEnvelope(bad)).toBeNull();
  });
});
