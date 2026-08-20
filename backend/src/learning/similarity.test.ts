/**
 * Pure similarity + assembly tests (item 6). The "repeated procedure" judgment
 * must be deterministic and auditable: same titles, same verdict, no model in
 * the loop. These pin keywording, the Jaccard threshold behavior, and the
 * deterministic SKILL.md assembly from a draft group.
 */
import { describe, expect, test } from "bun:test";
import {
  assembleSkillProposal,
  generalizeGist,
  procedureBackbone,
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

describe("generalizeGist", () => {
  test("strips run-specific ids but keeps stable arguments", () => {
    expect(
      generalizeGist("gh pr view 123 --repo acme/skynet in sb_a1b2c3d4e5"),
    ).toBe("gh pr view 123 --repo acme/skynet in <id>");
    expect(
      generalizeGist("cat /runs/0b6bcf59-9d55-4e8a-b6f1-24e0c9427d31/log deadbeefcafe build 84739"),
    ).toBe("cat /runs/<id>/log <id> build <n>");
  });
});

describe("procedureBackbone", () => {
  const oldTrace = [
    { tool: "bash", gist: "bun install", ok: true },
    { tool: "edit", gist: "src/config-11111111.ts", ok: true },
    { tool: "bash", gist: "bun test", ok: true },
  ];
  const midTrace = [
    { tool: "bash", gist: "bun install", ok: true },
    { tool: "webfetch", gist: "https://example.com/docs", ok: true },
    { tool: "edit", gist: "src/config-22222222.ts", ok: true },
  ];
  const newTrace = [
    { tool: "bash", gist: "bun install --frozen-lockfile", ok: true },
    { tool: "edit", gist: "src/config-33333333.ts", ok: true },
  ];

  test("keeps majority tools in first-seen order with the newest gist, generalized", () => {
    expect(procedureBackbone([oldTrace, midTrace, newTrace])).toEqual([
      { tool: "bash", gist: "bun install --frozen-lockfile" },
      { tool: "edit", gist: "src/config-<id>.ts" },
      // webfetch appears in 1 of 3 traces: below the majority, dropped.
    ]);
  });

  test("empty traces contribute nothing; no traces means no backbone", () => {
    expect(procedureBackbone([])).toEqual([]);
    expect(procedureBackbone([[], []])).toEqual([]);
    // A single trace is its own majority.
    expect(procedureBackbone([[], newTrace]).map((s) => s.tool)).toEqual(["bash", "edit"]);
  });

  test("deterministic", () => {
    const traces = [oldTrace, midTrace, newTrace];
    expect(procedureBackbone(traces)).toEqual(procedureBackbone(traces));
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

  test("drafts without traces fall back to the knowledge-search procedure", () => {
    const assembled = assembleSkillProposal(drafts);
    expect(assembled.sections.procedure[0]).toContain("Search org knowledge");
  });

  test("drafts with traces assemble the executable backbone instead", () => {
    const traced = drafts.map((d, i) => ({
      ...d,
      procedure: [
        { tool: "bash", gist: `vault kv get payments-${i}`, ok: true },
        { tool: "edit", gist: ".env.production", ok: true },
      ],
    }));
    const assembled = assembleSkillProposal(traced);
    expect(assembled.sections.procedure[0]).toBe("bash: vault kv get payments-2");
    expect(assembled.sections.procedure[1]).toBe("edit: .env.production");
    expect(assembled.sections.procedure.join("\n")).not.toContain("Search org knowledge");
    // The honest label: assembled from observed runs, adapt the specifics.
    expect(assembled.sections.procedure.at(-1)).toContain("Adapt file paths");
  });

  test("assembly is deterministic", () => {
    expect(assembleSkillProposal(drafts)).toEqual(assembleSkillProposal(drafts));
  });
});
