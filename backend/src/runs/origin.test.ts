// Pure policy for the server-owned internal-run authority boundary.
import { describe, expect, test } from "bun:test";
import {
  assertInternalRunOrigin,
  INTERNAL_RUN_ORIGINS,
  isInternalRunOrigin,
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
      "t3-parity",
      "canary",
      "e2e",
      "parity-canary",
      "internal:t3-parity:forged",
      "INTERNAL:T3-PARITY",
      "internal:unknown",
      "slack",
    ]) {
      expect(isInternalRunOrigin(origin)).toBe(false);
      if (origin !== null) expect(() => assertInternalRunOrigin(origin)).toThrow();
    }
  });
});
