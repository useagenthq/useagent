// Slice 3 step 7: every accepted OpenCode alias must normalize into the canonical
// lane identically to its base - no selectable engine silently outside it.

import { describe, expect, test } from "bun:test";
import { canonicalEngine } from "./engine-alias";
import { ENGINE_IDS } from "../db/schema";

describe("canonicalEngine alias normalization", () => {
  test("daytona (OpenCode alias) normalizes to opencode", () => {
    expect(canonicalEngine("daytona")).toBe("opencode");
  });
  test("claude-sdk (Claude alias) normalizes to claude", () => {
    expect(canonicalEngine("claude-sdk")).toBe("claude");
  });
  test("canonical providers pass through unchanged", () => {
    for (const e of ["opencode", "claude", "codex"]) expect(canonicalEngine(e)).toBe(e);
  });
  test("non-canonical ids pass through unchanged (mock/acp translate nothing)", () => {
    expect(canonicalEngine("mock")).toBe("mock");
    expect(canonicalEngine("acp")).toBe("acp");
  });
  test("every route-accepted engine id normalizes to a known canonical target", () => {
    // The canonical target of any accepted engine is either a canonical provider or
    // a deliberately non-canonical id (mock/acp) - never an unmapped alias.
    const canonicalTargets = new Set(["opencode", "claude", "codex", "mock", "acp"]);
    for (const id of ENGINE_IDS) {
      expect(canonicalTargets.has(canonicalEngine(id))).toBe(true);
    }
  });
});
