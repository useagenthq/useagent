import { describe, expect, test } from "bun:test";
import { parseConformanceTargets } from "../src/targets";

const allowed = {
  engines: new Set(["claude", "codex", "opencode", "pi"]),
  caseIds: new Set(["artifact-publish", "desktop-recording"]),
};

describe("portable conformance target selection", () => {
  test("accepts unique engine and case pairs", () => {
    expect(parseConformanceTargets(
      "claude:desktop-recording,pi:artifact-publish",
      allowed,
    )).toEqual([
      { engine: "claude", caseId: "desktop-recording" },
      { engine: "pi", caseId: "artifact-publish" },
    ]);
  });

  test("rejects malformed, unknown, and duplicate pairs", () => {
    expect(() => parseConformanceTargets("acp:desktop-recording", allowed)).toThrow("unsupported");
    expect(() => parseConformanceTargets("claude:unknown", allowed)).toThrow("unsupported");
    expect(() => parseConformanceTargets("claude:desktop-recording:extra", allowed))
      .toThrow("unsupported");
    expect(() => parseConformanceTargets(
      "claude:desktop-recording,claude:desktop-recording",
      allowed,
    )).toThrow("duplicate");
  });
});
