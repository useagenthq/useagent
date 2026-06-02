import { describe, expect, test } from "bun:test";
import { terminalCanonicalizationEligible } from "./finalize";

describe("terminal canonicalization eligibility", () => {
  test("Pi terminal runs enter the canonicalization outbox", () => {
    expect(terminalCanonicalizationEligible("pi")).toBe(true);
    expect(terminalCanonicalizationEligible("mock")).toBe(false);
  });
});
