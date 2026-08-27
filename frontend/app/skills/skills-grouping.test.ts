import { describe, expect, test } from "bun:test";

import {
  baseSkillName,
  groupSkills,
  recordToSkill,
  sourceRepoLabel,
  type Skill,
} from "./skills-data";

/**
 * The backend keeps skill names org-unique, so the same SKILL.md imported from
 * a second source gets a ladder-disambiguated name ("name (repo)", "name
 * (path)", "name (sha7)") - backend/src/skills/import-repo.ts. These tests pin
 * the presentation-side inverse: grouping consolidates exactly those records
 * into one row and never rewrites a hand-authored name.
 */

function makeSkill(overrides: Partial<Skill>): Skill {
  return {
    id: crypto.randomUUID(),
    name: "skill",
    kind: "skill",
    description: "",
    tags: [],
    sections: { overview: [], procedure: [], verify: [] },
    version: 1,
    sourceRepo: null,
    sourcePath: null,
    sourceSha: null,
    usageCount: 0,
    ...overrides,
  };
}

describe("baseSkillName", () => {
  test("strips the repo-name qualifier the import ladder appended", () => {
    const skill = makeSkill({
      name: "refactoring-guru (org-skills)",
      sourceRepo: "acme/org-skills",
      sourcePath: ".claude/skills/refactoring-guru/SKILL.md",
    });
    expect(baseSkillName(skill)).toBe("refactoring-guru");
  });

  test("strips path and short-sha qualifiers too", () => {
    const byPath = makeSkill({
      name: "deploy (.claude/skills/deploy/SKILL.md)",
      sourceRepo: "acme/tools",
      sourcePath: ".claude/skills/deploy/SKILL.md",
    });
    expect(baseSkillName(byPath)).toBe("deploy");

    const bySha = makeSkill({
      name: "deploy (abc1234)",
      sourceRepo: "acme/tools",
      sourcePath: "other/SKILL.md",
      sourceSha: "abc1234def5678",
    });
    expect(baseSkillName(bySha)).toBe("deploy");
  });

  test("never rewrites hand-authored names, even parenthesized ones", () => {
    expect(baseSkillName(makeSkill({ name: "review (strict)" }))).toBe(
      "review (strict)",
    );
    // Imported, but the qualifier is not from this record's own ladder.
    const unrelated = makeSkill({
      name: "review (strict)",
      sourceRepo: "acme/tools",
      sourcePath: "x/SKILL.md",
    });
    expect(baseSkillName(unrelated)).toBe("review (strict)");
  });
});

describe("groupSkills", () => {
  test("merges ladder-suffixed duplicates into one row, most-used first", () => {
    const original = makeSkill({
      name: "refactoring-guru",
      sourceRepo: "acme/sample-skills",
      sourcePath: "skills/refactoring-guru/SKILL.md",
      usageCount: 2,
    });
    const duplicate = makeSkill({
      name: "refactoring-guru (org-skills)",
      sourceRepo: "acme/org-skills",
      sourcePath: ".claude/skills/refactoring-guru/SKILL.md",
      usageCount: 5,
    });
    const other = makeSkill({ name: "ship-a-page" });

    const groups = groupSkills([original, duplicate, other]);
    expect(groups.length).toBe(2);
    const merged = groups.find((g) => g.name === "refactoring-guru");
    expect(merged?.variants.length).toBe(2);
    expect(merged?.variants[0].id).toBe(duplicate.id);
    expect(groups.find((g) => g.name === "ship-a-page")?.variants.length).toBe(1);
  });

  test("keeps distinct names as distinct rows", () => {
    const groups = groupSkills([
      makeSkill({ name: "alpha" }),
      makeSkill({ name: "beta" }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["alpha", "beta"]);
  });
});

describe("provenance mapping", () => {
  test("recordToSkill carries the import source fields", () => {
    const skill = recordToSkill({
      id: "s1",
      name: "deploy",
      description: "",
      source_repo: "acme/tools",
      source_path: "skills/deploy/SKILL.md",
      source_sha: "abc1234def",
    });
    expect(skill.sourceRepo).toBe("acme/tools");
    expect(skill.sourcePath).toBe("skills/deploy/SKILL.md");
    expect(skill.sourceSha).toBe("abc1234def");
    expect(sourceRepoLabel(skill)).toBe("tools");
  });

  test("hand-authored records resolve to null provenance", () => {
    const skill = recordToSkill({ id: "s2", name: "review", description: "" });
    expect(skill.sourceRepo).toBeNull();
    expect(sourceRepoLabel(skill)).toBeNull();
  });
});
