import { describe, expect, test } from "bun:test";
import { deriveFallbackName, parseSkillMarkdown } from "../src/skills/import";
import { formatSkillMarkdown } from "../src/skills/format";

// Pure-function tests for the SKILL.md parser — no network, no DB.

const canonical = `---
name: Deploy Runbook
description: How we ship
---

# Deploy Runbook

How we ship

## Overview
- gives context

## Procedure
1. build the image
2. roll it out

## Verify
- smoke test passes
`;

describe("parseSkillMarkdown", () => {
  test("reads frontmatter name/description and maps canonical sections", () => {
    const c = parseSkillMarkdown(canonical, "fallback-name");
    expect(c.name).toBe("Deploy Runbook");
    expect(c.description).toBe("How we ship");
    // The H1 title + a line echoing the description are dropped from Overview.
    expect(c.sections.overview).toEqual(["gives context"]);
    expect(c.sections.procedure).toEqual(["build the image", "roll it out"]);
    expect(c.sections.verify).toEqual(["smoke test passes"]);
  });

  test("falls back to the directory name when frontmatter has no name", () => {
    const raw = `# Some Title

just prose here
and a second line
`;
    const c = parseSkillMarkdown(raw, "my-skill");
    expect(c.name).toBe("my-skill");
    expect(c.description).toBe("");
    // No canonical headings -> the whole body (minus the H1) folds into Overview.
    expect(c.sections.overview).toEqual(["just prose here", "and a second line"]);
    expect(c.sections.procedure).toEqual([]);
    expect(c.sections.verify).toEqual([]);
  });

  test("strips quotes on frontmatter values", () => {
    const raw = `---
name: "Quoted Name"
description: 'single quoted'
---
body
`;
    const c = parseSkillMarkdown(raw, "fb");
    expect(c.name).toBe("Quoted Name");
    expect(c.description).toBe("single quoted");
  });

  test("folded and literal block-scalar frontmatter values are read, not taken literally", () => {
    const raw = `---
name: access-chase
description: >-
  Chase down access requests
  across every system: fast.
notes: |-
  line one
  line two
---
body
`;
    const c = parseSkillMarkdown(raw, "fb");
    expect(c.name).toBe("access-chase");
    // Folded (>) joins continuation lines with spaces; the colon inside the
    // continuation must not be mistaken for a new key.
    expect(c.description).toBe("Chase down access requests across every system: fast.");
  });

  test("non-canonical ## sections fold into Overview, keeping their label", () => {
    const raw = `---
name: X
---
## Overview
- a
## Notes
- keep me
`;
    const c = parseSkillMarkdown(raw, "fb");
    expect(c.sections.overview).toEqual(["a", "Notes", "keep me"]);
  });

  test("a canonical doc round-trips through formatSkillMarkdown (idempotent re-parse)", () => {
    const once = parseSkillMarkdown(canonical, "fb");
    const twice = parseSkillMarkdown(formatSkillMarkdown(once), "fb");
    expect(twice).toEqual(once);
  });

  test("parsing is deterministic for identical input", () => {
    expect(parseSkillMarkdown(canonical, "fb")).toEqual(parseSkillMarkdown(canonical, "fb"));
  });
});

describe("deriveFallbackName", () => {
  test("uses the parent directory for a nested SKILL.md", () => {
    expect(deriveFallbackName(".claude/skills/deploy/SKILL.md", "acme/tools")).toBe("deploy");
    expect(deriveFallbackName("skills/lint/SKILL.md", "acme/tools")).toBe("lint");
  });

  test("uses the repo name for a root-level SKILL.md", () => {
    expect(deriveFallbackName("SKILL.md", "acme/tools")).toBe("tools");
  });
});
