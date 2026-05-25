/**
 * Pure similarity + assembly tests (item 6). The "repeated procedure" judgment
 * must be deterministic and auditable: same titles, same verdict, no model in
 * the loop. These pin keywording, the Jaccard threshold behavior, and the
 * deterministic SKILL.md assembly from a draft group.
 */
import { describe, expect, test } from "bun:test";
import {
  assembleSkillProposal,
  SIMILARITY_THRESHOLD,
  titleKeywords,
  titleSimilarity,
  topKeywords,
} from "./similarity";

describe("titleKeywords", () => {
  test("lowercases, splits on non-alphanumerics, drops short words + stopwords", () => {
    expect(titleKeywords("Deploy the Billing-Service to staging")).toEqual(
      new Set(["deploy", "billing", "service", "staging"]),
    );
  });

  test("an all-stopword title has no keywords", () => {
    expect(titleKeywords("do it for me").size).toBe(0);
  });
});

describe("titleSimilarity", () => {
  test("identical procedures score 1", () => {
    expect(titleSimilarity("Rotate the API keys", "Rotate the API keys")).toBe(1);
  });

  test("same procedure, different phrasing, crosses the threshold", () => {
    const sim = titleSimilarity(
      "Rotate expired API keys for the payments service",
      "Rotate API keys for payments service",
    );
    expect(sim).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
  });

  test("unrelated procedures stay below the threshold", () => {
    const sim = titleSimilarity(
      "Rotate expired API keys for the payments service",
      "Generate the quarterly revenue report deck",
    );
    expect(sim).toBeLessThan(SIMILARITY_THRESHOLD);
  });

  test("keyword-free titles match nothing (never everything)", () => {
    expect(titleSimilarity("do it", "do it")).toBe(0);
  });

  test("deterministic and symmetric", () => {
    const a = "Backfill missing invoices";
    const b = "Backfill the missing invoice rows";
    expect(titleSimilarity(a, b)).toBe(titleSimilarity(b, a));
    expect(titleSimilarity(a, b)).toBe(titleSimilarity(a, b));
  });
});

describe("topKeywords", () => {
  test("ranks by frequency, tie-breaks alphabetically, caps the list", () => {
    expect(
      topKeywords(
        ["rotate api keys", "rotate api keys payments", "rotate payments zebra"],
        3,
      ),
    ).toEqual(["rotate", "api", "keys"]);
  });
});

describe("assembleSkillProposal", () => {
  const drafts = [
    { id: "d1", runId: "11111111-aaaa", title: "Rotate API keys for payments" },
    { id: "d2", runId: "22222222-bbbb", title: "Rotate the API keys for payments service" },
    { id: "d3", runId: "33333333-cccc", title: "Rotate expired API keys for payments" },
  ];

  test("names the proposal after the newest draft and records provenance", () => {
    const assembled = assembleSkillProposal(drafts);
    expect(assembled.name).toBe("Rotate expired API keys for payments");
    expect(assembled.description).toContain("3 accepted learnings");
    // Every source draft appears in the overview with its run reference.
    expect(assembled.sections.overview.join("\n")).toContain("(run 11111111)");
    expect(assembled.sections.overview.join("\n")).toContain("(run 33333333)");
    expect(assembled.sections.procedure.length).toBeGreaterThan(0);
    expect(assembled.sections.verify.length).toBeGreaterThan(0);
  });

  test("assembly is deterministic", () => {
    expect(assembleSkillProposal(drafts)).toEqual(assembleSkillProposal(drafts));
  });
});
