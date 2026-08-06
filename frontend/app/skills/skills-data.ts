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
 * {@link mockSkills} — deliberately empty, so the fallback is an honest empty
 * state, never fabricated content.
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
/*  Fallback                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * SSR fallback used only while the backend is unreachable. Intentionally empty:
 * the view renders its honest "No skills yet" empty state and self-heals via a
 * client refetch once the backend responds. Never seed demo content here.
 */
export const mockSkills: Skill[] = [];

