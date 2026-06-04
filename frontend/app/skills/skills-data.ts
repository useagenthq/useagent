import { type ChipColor } from "../knowledge/knowledge-data";
import { relativeTime } from "@/utils/format";

/**
 * Skills data model + view-model mappers.
 *
 * Wired to `/api/skills`. A skill is a reusable instruction set: name,
 * description, tags, and three step-sections (overview / procedure / verify).
 * The same substrate also backs Playbooks (`kind: "playbook"`); this module is
 * the shared client for both surfaces. Skills imported from GitHub carry their
 * source provenance (repo / path / sha). When the backend is unreachable the
 * page falls back to {@link mockSkills} - deliberately empty, so the fallback is
 * an honest empty state, never fabricated content.
 */

/* -------------------------------------------------------------------------- */
/*  Backend contract                                                            */
/* -------------------------------------------------------------------------- */

/** The two product surfaces over the one versioned-skill substrate. */
export type SkillKind = "skill" | "playbook";

/** A section is stored as steps - tolerate a newline-joined string too. */
type RawSection = string | string[] | null | undefined;

export interface SkillRecord {
  id: string;
  name: string;
  kind?: SkillKind;
  description: string;
  tags?: string[];
  sections?: {
    overview?: RawSection;
    procedure?: RawSection;
    verify?: RawSection;
  };
  current_version?: number;
  /** GitHub import provenance - null/absent for hand-authored skills. */
  source_repo?: string | null;
  source_path?: string | null;
  source_sha?: string | null;
  usage_count?: number;
  last_run_at?: string;
}

/* -------------------------------------------------------------------------- */
/*  View model                                                                  */
/* -------------------------------------------------------------------------- */

export interface Skill {
  id: string;
  name: string;
  kind: SkillKind;
  description: string;
  tags: string[];
  sections: { overview: string[]; procedure: string[]; verify: string[] };
  /** Current immutable revision; sent with a run so the backend pins it. */
  version: number;
  /** "owner/repo" the skill was imported from; null when hand-authored. */
  sourceRepo: string | null;
  /** Path of the SKILL.md inside the source repo; null when hand-authored. */
  sourcePath: string | null;
  /** Commit the imported content was read at; null when hand-authored. */
  sourceSha: string | null;
  usageCount: number;
  lastRunAt?: string;
}

/* -------------------------------------------------------------------------- */
/*  Colors                                                                      */
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
    kind: record.kind === "playbook" ? "playbook" : "skill",
    description: record.description,
    tags: record.tags ?? [],
    sections: {
      overview: toSteps(record.sections?.overview),
      procedure: toSteps(record.sections?.procedure),
      verify: toSteps(record.sections?.verify),
    },
    version: record.current_version && record.current_version > 0 ? record.current_version : 1,
    sourceRepo: record.source_repo ?? null,
    sourcePath: record.source_path ?? null,
    sourceSha: record.source_sha ?? null,
    usageCount: record.usage_count ?? 0,
    lastRunAt: record.last_run_at,
  };
}

/** "Used 14 times · last run 2d ago" caption from a skill. A zero-state stays
 *  quiet as "Unused" rather than shouting "Used 0 times". */
export function usageCaption(skill: Skill): string {
  if (skill.usageCount === 0) return "Unused";
  const uses = `Used ${skill.usageCount} ${skill.usageCount === 1 ? "time" : "times"}`;
  return skill.lastRunAt
    ? `${uses} · last run ${relativeTime(skill.lastRunAt)}`
    : uses;
}

/* -------------------------------------------------------------------------- */
/*  Grouping (import-name deduplication)                                        */
/* -------------------------------------------------------------------------- */

/**
 * The backend keeps skill names org-unique, so importing the same SKILL.md from
 * a second source mints a disambiguated name via a deterministic ladder:
 * `base`, `base (repoName)`, `base (sourcePath)`, `base (shortSha)` - see
 * backend/src/skills/import-repo.ts. That is why the library used to show
 * "refactoring-guru" AND "refactoring-guru (org-skills)" as two
 * near-identical cards: they are genuinely distinct records from different
 * sources.
 *
 * `baseSkillName` inverts exactly that ladder - it strips a trailing
 * parenthetical ONLY when the skill is imported and the parenthetical matches
 * that record's own repo name, source path, or short sha. A hand-authored skill
 * literally named "foo (bar)" is never rewritten.
 */
export function baseSkillName(skill: Skill): string {
  if (!skill.sourceRepo) return skill.name;
  const match = /^(.*) \(([^()]+)\)$/.exec(skill.name);
  if (!match) return skill.name;
  const [, base, qualifier] = match;
  const repoName = skill.sourceRepo.split("/")[1] ?? skill.sourceRepo;
  const candidates = [
    repoName,
    skill.sourcePath ?? "",
    skill.sourceSha?.slice(0, 7) ?? "",
  ];
  return candidates.includes(qualifier) ? base : skill.name;
}

/** One library row: a skill name plus every distinct record carrying it. */
export interface SkillGroup {
  /** Stable key (lowercased display name). */
  key: string;
  /** The shared display name (import-ladder suffix stripped). */
  name: string;
  /** The distinct records, most-used first (ties: newest version first). */
  variants: Skill[];
}

/** Group skills by their base name so one skill imported from several sources
 *  renders as ONE row with source badges instead of near-duplicate cards.
 *  Input order (backend: newest first) decides group order. */
export function groupSkills(skills: Skill[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const skill of skills) {
    const name = baseSkillName(skill);
    const key = name.toLowerCase();
    const existing = groups.get(key);
    if (existing) existing.variants.push(skill);
    else groups.set(key, { key, name, variants: [skill] });
  }
  for (const group of groups.values()) {
    if (group.variants.length > 1) {
      group.variants.sort((a, b) => b.usageCount - a.usageCount);
    }
  }
  return [...groups.values()];
}

/** Short source label for badges: the repo name of "owner/repo". */
export function sourceRepoLabel(skill: Skill): string | null {
  if (!skill.sourceRepo) return null;
  return skill.sourceRepo.split("/")[1] ?? skill.sourceRepo;
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
