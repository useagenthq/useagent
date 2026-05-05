import {
  RiBracesLine,
  RiBugLine,
  RiDashboardLine,
  RiEyeLine,
  RiFlashlightLine,
  RiGitBranchLine,
  RiPaletteLine,
  RiQuillPenLine,
  RiShieldCheckLine,
  RiTerminalBoxLine,
  type RemixiconComponentType,
} from "@remixicon/react";

import { type ChipColor } from "../knowledge/knowledge-data";
import { relativeTime } from "@/utils/format";

/**
 * Skills data model + view-model mappers.
 *
 * Wired to `/api/skills`. A skill is a reusable playbook: name, description,
 * tags, and three step-sections (overview / procedure / verify). The
 * highest-`usage_count` skill is rendered as the featured card; the rest fill
 * the library grid. When the backend is unreachable the page falls back to
 * {@link mockSkills} so it never looks broken.
 */

/* -------------------------------------------------------------------------- */
/*  Backend contract                                                            */
/* -------------------------------------------------------------------------- */

/** A section is stored as steps — tolerate a newline-joined string too. */
type RawSection = string | string[] | null | undefined;

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  sections?: {
    overview?: RawSection;
    procedure?: RawSection;
    verify?: RawSection;
  };
  usage_count?: number;
  last_run_at?: string;
}

/* -------------------------------------------------------------------------- */
/*  View model                                                                  */
/* -------------------------------------------------------------------------- */

export interface Skill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  sections: { overview: string[]; procedure: string[]; verify: string[] };
  usageCount: number;
  lastRunAt?: string;
}

/* -------------------------------------------------------------------------- */
/*  Colors + icons                                                              */
/* -------------------------------------------------------------------------- */

const tagPalette: ChipColor[] = [
  "blue",
  "purple",
  "sky",
  "green",
  "yellow",
  "red",
];

const knownTagColor: Record<string, ChipColor> = {
  frontend: "blue",
  backend: "purple",
  review: "sky",
  docs: "gray",
  boardui: "sky",
  alignui: "sky",
};

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic Badge color for an arbitrary tag. */
export function tagChipColor(tag: string): ChipColor {
  if (tag in knownTagColor) return knownTagColor[tag];
  return tagPalette[hash(tag) % tagPalette.length];
}

/** Icon pool indexed deterministically so the library keeps its visual variety. */
export const skillIconPool: RemixiconComponentType[] = [
  RiBugLine,
  RiEyeLine,
  RiDashboardLine,
  RiQuillPenLine,
  RiPaletteLine,
  RiBracesLine,
  RiTerminalBoxLine,
  RiGitBranchLine,
  RiShieldCheckLine,
  RiFlashlightLine,
];

/** Deterministic icon-pool index for a skill (resolve via `skillIconPool`). */
export function skillIconIndex(skill: Skill): number {
  return hash(skill.id || skill.name) % skillIconPool.length;
}

/* -------------------------------------------------------------------------- */
/*  Mappers                                                                     */
/* -------------------------------------------------------------------------- */

function toSteps(section: RawSection): string[] {
  if (Array.isArray(section)) return section.map((s) => s.trim()).filter(Boolean);
  if (typeof section === "string") {
    return section
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function recordToSkill(record: SkillRecord): Skill {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    tags: record.tags ?? [],
    sections: {
      overview: toSteps(record.sections?.overview),
      procedure: toSteps(record.sections?.procedure),
      verify: toSteps(record.sections?.verify),
    },
    usageCount: record.usage_count ?? 0,
    lastRunAt: record.last_run_at,
  };
}

/** "Used 14 times · last run 2d ago" caption from a skill. */
export function usageCaption(skill: Skill): string {
  const uses = `Used ${skill.usageCount} ${
    skill.usageCount === 1 ? "time" : "times"
  }`;
  return skill.lastRunAt
    ? `${uses} · last run ${relativeTime(skill.lastRunAt)}`
    : uses;
}

/** Highest-usage skill becomes the featured card. */
export function pickFeatured(skills: Skill[]): Skill | undefined {
  if (skills.length === 0) return undefined;
  return skills.reduce((top, s) => (s.usageCount > top.usageCount ? s : top));
}

/* -------------------------------------------------------------------------- */
/*  Mock fallback                                                               */
/* -------------------------------------------------------------------------- */

export const mockSkills: Skill[] = [
  {
    id: "ship-a-new-page",
    name: "Ship a new page",
    description:
      "When we need a new route that matches the AlignUI shell and token rules end to end.",
    tags: ["frontend", "alignui"],
    sections: {
      overview: [
        "Confirm the route path and which sidebar it belongs under.",
        "Read AGENTS.md and the nearest sibling page for patterns.",
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
    usageCount: 34,
    lastRunAt: undefined,
  },
  {
    id: "fix-flaky-test",
    name: "Fix flaky test",
    description:
      "Reproduce, isolate, and stabilize an intermittently failing test.",
    tags: ["backend", "review"],
    sections: { overview: [], procedure: [], verify: [] },
    usageCount: 31,
  },
  {
    id: "refactor-to-tokens",
    name: "Refactor to tokens",
    description: "Replace raw hex and dark: prefixes with semantic classes.",
    tags: ["frontend", "review"],
    sections: { overview: [], procedure: [], verify: [] },
    usageCount: 27,
  },
  {
    id: "design-review-pass",
    name: "Design review pass",
    description: "Audit a surface against the AlignUI kit and token rules.",
    tags: ["review", "frontend"],
    sections: { overview: [], procedure: [], verify: [] },
    usageCount: 22,
  },
  {
    id: "write-release-notes",
    name: "Write release notes",
    description: "Summarize merged PRs into a clear changelog entry.",
    tags: ["docs"],
    sections: { overview: [], procedure: [], verify: [] },
    usageCount: 18,
  },
  {
    id: "port-dashboard-widget",
    name: "Port dashboard widget",
    description: "Rebuild a chartden widget in Skynet tokens and layout.",
    tags: ["frontend"],
    sections: { overview: [], procedure: [], verify: [] },
    usageCount: 12,
  },
  {
    id: "add-api-route",
    name: "Add API route",
    description: "Scaffold a typed route handler with validation and tests.",
    tags: ["backend"],
    sections: { overview: [], procedure: [], verify: [] },
    usageCount: 9,
  },
];
