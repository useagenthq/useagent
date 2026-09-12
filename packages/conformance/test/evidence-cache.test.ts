import { describe, expect, test } from "bun:test";
import {
  applyConformanceEvidenceRows,
  mergeConformanceEvidenceRows,
  planConformanceEvidenceReuse,
} from "../src/evidence-cache";

const expected = ["codex:repo-clone", "claude:repo-clone", "pi:artifact-publish"];
const pass = (engine: string, caseId: string) => ({ engine, caseId, passed: true, errors: [] });

describe("portable conformance evidence reuse", () => {
  test("resumes from partial evidence and refreshes only missing or failed rows", () => {
    const rows = [
      pass("codex", "repo-clone"),
      { engine: "claude", caseId: "repo-clone", passed: false, errors: ["refused"] },
    ];
    expect(planConformanceEvidenceReuse(expected, rows)).toEqual({
      total: 3,
      reused: 1,
      refresh: [
        { engine: "claude", caseId: "repo-clone" },
        { engine: "pi", caseId: "artifact-publish" },
      ],
    });

    const merged = mergeConformanceEvidenceRows(expected, rows, new Map([
      ["claude:repo-clone", pass("claude", "repo-clone")],
      ["pi:artifact-publish", pass("pi", "artifact-publish")],
    ]));
    expect(merged).toEqual([
      pass("codex", "repo-clone"),
      pass("claude", "repo-clone"),
      pass("pi", "artifact-publish"),
    ]);

    expect(applyConformanceEvidenceRows(expected, rows, new Map([
      ["claude:repo-clone", pass("claude", "repo-clone")],
    ]))).toEqual([
      pass("codex", "repo-clone"),
      pass("claude", "repo-clone"),
    ]);
  });

  test("rejects unknown, duplicate, missing, and unexpected refresh rows", () => {
    expect(() => planConformanceEvidenceReuse(expected, [pass("unknown", "case")]))
      .toThrow("unknown target");
    expect(() => planConformanceEvidenceReuse(expected, [
      pass("codex", "repo-clone"),
      pass("codex", "repo-clone"),
    ])).toThrow("duplicate");
    expect(() => mergeConformanceEvidenceRows(expected, [pass("codex", "repo-clone")], new Map()))
      .toThrow("missing refreshed evidence");
  });
});
