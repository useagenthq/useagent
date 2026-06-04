import { describe, expect, test } from "bun:test";
import { isRedundantDescription, visibleDescription } from "./list-row";

describe("isRedundantDescription", () => {
  test("drops a description that repeats the title behind a label prefix", () => {
    expect(
      isRedundantDescription("Balance Customer Escalation KPI", "Playbook: Balance Customer Escalation KPI"),
    ).toBe(true);
  });

  test("drops a bare restatement of the title", () => {
    expect(isRedundantDescription("Customer Kickoff Deck", "Customer Kickoff Deck")).toBe(true);
  });

  test("is case-insensitive and ignores trailing punctuation", () => {
    expect(isRedundantDescription("foo", "Skill: FOO.")).toBe(true);
  });

  test("treats an empty or whitespace description as redundant", () => {
    expect(isRedundantDescription("Anything", "   ")).toBe(true);
    expect(isRedundantDescription("Anything", "")).toBe(true);
  });

  test("keeps a genuinely different description", () => {
    expect(
      isRedundantDescription("loop-pr-demo", "Test a GitHub pull request linked in Slack or chat"),
    ).toBe(false);
  });

  test("keeps an informative description that only opens with the title", () => {
    // Not a raw startsWith: the tail carries real information, so it stays.
    expect(isRedundantDescription("pdf-tools", "pdf-tools - fill and extract PDF forms")).toBe(false);
  });

  test("keeps a label-prefixed description that differs from the title", () => {
    expect(
      isRedundantDescription("James Research", "Playbook: Fast Restaurant / Hospitality Group Research"),
    ).toBe(false);
  });
});

describe("visibleDescription", () => {
  test("returns null for a redundant description", () => {
    expect(visibleDescription("Customer Kickoff Deck", "Playbook: Customer Kickoff Deck")).toBeNull();
  });

  test("returns the trimmed description when it adds information", () => {
    expect(visibleDescription("loop-pr-demo", "  Test a GitHub PR  ")).toBe("Test a GitHub PR");
  });
});
