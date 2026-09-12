import { describe, expect, test } from "bun:test";
import { combineConformanceEvidence } from "../src/evidence-combine";

const pass = (engine: string, caseId: string) => ({ engine, caseId, passed: true, errors: [] });

describe("portable conformance evidence combination", () => {
  test("combines disjoint targeted and remaining evidence into one complete matrix", () => {
    expect(combineConformanceEvidence(
      ["pi:artifact-publish", "pi:repo-clone"],
      [
        { provider: "cube", snapshot: "tpl-1", results: [pass("pi", "artifact-publish")] },
        { provider: "cube", snapshot: "tpl-1", results: [pass("pi", "repo-clone")] },
      ],
    )).toMatchObject({ complete: true, expectedTotal: 2, passed: 2, total: 2 });
  });

  test("rejects duplicate, missing, and mixed-runtime evidence", () => {
    expect(() => combineConformanceEvidence(
      ["pi:artifact-publish"],
      [
        { provider: "cube", snapshot: "tpl-1", results: [pass("pi", "artifact-publish")] },
        { provider: "cube", snapshot: "tpl-1", results: [pass("pi", "artifact-publish")] },
      ],
    )).toThrow("duplicate");
    expect(() => combineConformanceEvidence(
      ["pi:artifact-publish", "pi:repo-clone"],
      [{ provider: "cube", snapshot: "tpl-1", results: [pass("pi", "artifact-publish")] }],
    )).toThrow("missing refreshed evidence");
    expect(() => combineConformanceEvidence(
      ["pi:artifact-publish", "pi:repo-clone"],
      [
        { provider: "cube", snapshot: "tpl-1", results: [pass("pi", "artifact-publish")] },
        { provider: "daytona", snapshot: "snapshot-2", results: [pass("pi", "repo-clone")] },
      ],
    )).toThrow("provider or snapshot mismatch");
  });
});
