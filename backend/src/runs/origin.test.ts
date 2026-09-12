// Pure policy for the server-owned internal-run authority boundary.
import { describe, expect, test } from "bun:test";
import {
  assertInternalRunOrigin,
  assertUnattendedRunOrigin,
  BOT_HANDOFF_RUN_ORIGIN,
  INTERNAL_RUN_ORIGINS,
  isInternalRunOrigin,
  isUnattendedRunOrigin,
  AUTOMATION_RUN_ORIGIN,
} from "./origin";

describe("isInternalRunOrigin", () => {
  test("accepts only the exact server-owned allowlist", () => {
    for (const origin of INTERNAL_RUN_ORIGINS) {
      expect(isInternalRunOrigin(origin)).toBe(true);
      expect(() => assertInternalRunOrigin(origin)).not.toThrow();
    }
  });

  test("rejects null, legacy values, prefixes, suffixes, and unknown internal values", () => {
    for (const origin of [
      null,
      "release-eval",
      "canary",
      "e2e",
      "parity-canary",
      "internal:release-parity:forged",
      "internal:model-qualification:forged",
      "INTERNAL:RELEASE-PARITY",
      "internal:unknown",
      "slack",
    ]) {
      expect(isInternalRunOrigin(origin)).toBe(false);
      if (origin !== null) expect(() => assertInternalRunOrigin(origin)).toThrow();
    }
  });
});

describe("unattended product origins", () => {
  test("accepts only server-owned automation and bot provenance", () => {
    for (const origin of [AUTOMATION_RUN_ORIGIN, BOT_HANDOFF_RUN_ORIGIN]) {
      expect(isUnattendedRunOrigin(origin)).toBe(true);
      expect(() => assertUnattendedRunOrigin(origin)).not.toThrow();
      expect(isInternalRunOrigin(origin)).toBe(false);
    }
    for (const origin of [null, "product:web", "product:automation:forged", "internal:canary"]) {
      expect(isUnattendedRunOrigin(origin)).toBe(false);
      if (origin !== null) expect(() => assertUnattendedRunOrigin(origin)).toThrow();
    }
  });
});
