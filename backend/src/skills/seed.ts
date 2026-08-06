import type { SkillSections } from "../db/schema";
import { createSkillWithRevision, ensureCurrentRevision } from "./repo";

interface SkillSeed {
  name: string;
  description: string;
  tags: string[];
  sections: SkillSections;
  usageCount: number;
  /** whole days since the last run, or null if never run */
  lastRunDaysAgo: number | null;
}

// The 7 skills currently mocked in frontend/app/skills/ — the featured
// "Ship a new page" plus the six library cards. Sections mirror the featured
// card's anatomy (overview / procedure / verify).
const SKILL_SEEDS: SkillSeed[] = [
  {
    name: "Ship a new page",
    description:
      "When we need a new route that matches the BoardUI shell and token rules end to end.",
    tags: ["frontend", "boardui"],
    sections: {
      overview: [
        "Confirm the route path and which sidebar it belongs under.",
        "Read DESIGN-BRIEF and the nearest sibling page for patterns.",
      ],
      procedure: [
        "Scaffold page.tsx inside AppShell with the matching sidebar.",
        "Build the header, then colocate the section components.",
        "Add a client boundary only where interactivity is needed.",
      ],
      verify: [
        "curl the route for 200 and your heading text.",
        "Run tsc --noEmit and confirm the dev log is clean.",
      ],
    },
    usageCount: 14,
    lastRunDaysAgo: 2,
  },
  {
    name: "Fix flaky test",
    description:
      "Reproduce, isolate, and stabilize an intermittently failing test.",
    tags: ["backend", "review"],
    sections: {
      overview: [
        "Pin down which test flakes and how often it fails.",
        "Read the test and the code path it exercises for shared state.",
      ],
      procedure: [
        "Run the test in a loop to reproduce the flake reliably.",
        "Isolate the nondeterminism — timers, ordering, async, or fixtures.",
        "Apply the fix and rerun the loop to confirm stability.",
      ],
      verify: [
        "Run the test 50x with zero failures.",
        "Confirm the suite stays green in CI.",
      ],
    },
    usageCount: 31,
    lastRunDaysAgo: null,
  },
  {
    name: "Design review pass",
    description: "Audit a surface against the BoardUI kit and token rules.",
    tags: ["review", "frontend"],
    sections: {
      overview: [
        "Identify the surface and the screens in scope.",
        "Open DESIGN-BRIEF and the BoardUI primitives it should use.",
      ],
      procedure: [
        "Check every color, spacing, and radius against semantic tokens.",
        "Flag raw hex, dark: prefixes, and one-off components.",
        "Note each fix inline with the token or primitive to use instead.",
      ],
      verify: [
        "No raw hex or dark: prefixes remain.",
        "Run typecheck and confirm the dev log is clean.",
      ],
    },
    usageCount: 22,
    lastRunDaysAgo: null,
  },
  {
    name: "Port dashboard widget",
    description: "Rebuild a chartden widget in Skynet tokens and layout.",
    tags: ["frontend"],
    sections: {
      overview: [
        "Locate the source widget and its data shape.",
        "Find the nearest Skynet dashboard pattern to match.",
      ],
      procedure: [
        "Recreate the layout with AppShell and BoardUI primitives.",
        "Map the data into the widget using semantic tokens.",
        "Wire interactivity at the leaf client component only.",
      ],
      verify: [
        "Widget renders with live data at the target route.",
        "Run typecheck and visually diff against the source.",
      ],
    },
    usageCount: 12,
    lastRunDaysAgo: null,
  },
  {
    name: "Write release notes",
    description: "Summarize merged PRs into a clear changelog entry.",
    tags: ["docs"],
    sections: {
      overview: [
        "Collect the merged PRs since the last release.",
        "Group them by feature, fix, and chore.",
      ],
      procedure: [
        "Draft one plain-language line per user-facing change.",
        "Lead with highlights, then fixes, then internal notes.",
        "Link each entry back to its PR.",
      ],
      verify: [
        "Every user-facing PR is represented.",
        "A non-author can read it and understand what changed.",
      ],
    },
    usageCount: 18,
    lastRunDaysAgo: null,
  },
  {
    name: "Refactor to tokens",
    description: "Replace raw hex and dark: prefixes with semantic classes.",
    tags: ["frontend", "review"],
    sections: {
      overview: [
        "Scan the target files for raw hex and dark: usage.",
        "Map each value to its semantic token.",
      ],
      procedure: [
        "Swap raw colors for background/text/border tokens.",
        "Remove dark: prefixes and rely on the .dark class.",
        "Collapse duplicated one-off styles into shared primitives.",
      ],
      verify: [
        "No raw hex or dark: prefixes remain in the diff.",
        "Light and dark themes both render correctly.",
      ],
    },
    usageCount: 27,
    lastRunDaysAgo: null,
  },
  {
    name: "Add API route",
    description: "Scaffold a typed route handler with validation and tests.",
    tags: ["backend"],
    sections: {
      overview: [
        "Confirm the method, path, and request/response shape.",
        "Find a sibling route to match structure and conventions.",
      ],
      procedure: [
        "Scaffold the handler with typed input validation.",
        "Implement the data access and error responses.",
        "Add tests covering valid and invalid inputs.",
      ],
      verify: [
        "curl the route for the happy path and a validation error.",
        "Run the test suite and typecheck clean.",
      ],
    },
    usageCount: 9,
    lastRunDaysAgo: null,
  },
];

const DAY_MS = 86_400_000;

/**
 * Idempotently seed the mocked skills for an org. Each seed becomes a skill + its
 * immutable version-1 revision (via `createSkillWithRevision`). For a skill that
 * already exists from an older seed (no revision yet), `ensureCurrentRevision`
 * backfills its current-version revision — so every seeded skill is resolvable by
 * a run. No-op once fully present.
 */
export async function seedSkills(orgId: string): Promise<void> {
  for (const s of SKILL_SEEDS) {
    await createSkillWithRevision({
      orgId,
      name: s.name,
      description: s.description,
      tags: s.tags,
      sections: s.sections,
      usageCount: s.usageCount,
      lastRunAt:
        s.lastRunDaysAgo == null
          ? null
          : new Date(Date.now() - s.lastRunDaysAgo * DAY_MS),
    });
    await ensureCurrentRevision(orgId, s.name);
  }
}
