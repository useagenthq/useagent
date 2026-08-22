import { backendFetch } from "@/lib/backend-fetch";
import { recordToSkill, type Skill, type SkillKind, type SkillRecord } from "./skills-data";

/**
 * Thin fetch layer for the skills endpoints - the shared client for both the
 * Skills and Playbooks surfaces (one substrate, split by `kind`). Routing
 * (backend origin + cookie forwarding on the server, relative path on the
 * client) lives in `backendFetch`. Every call throws on a non-2xx so callers can
 * fall back to mock data or revert an optimistic update.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

/** List skills of a given kind (omit `kind` for every kind). */
export async function fetchSkills(kind?: SkillKind): Promise<Skill[]> {
  const path = kind ? `/api/skills?kind=${kind}` : "/api/skills";
  const res = await backendFetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`skills ${res.status}`);
  const data = (await res.json()) as { skills?: SkillRecord[] };
  return (data.skills ?? []).map(recordToSkill);
}

/** Library listing: every skill of a kind WITHOUT instruction sections. An org
 *  with hundreds of imported skills carries megabytes of section content the
 *  list never renders - the detail view loads one skill via {@link fetchSkill}. */
export async function fetchSkillsLibrary(kind: SkillKind): Promise<Skill[]> {
  const res = await backendFetch(`/api/skills?kind=${kind}&view=library`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`skills ${res.status}`);
  const data = (await res.json()) as { skills?: SkillRecord[] };
  return (data.skills ?? []).map(recordToSkill);
}

/** Fetch one skill with its full sections (the detail view's data). */
export async function fetchSkill(id: string): Promise<Skill> {
  const res = await backendFetch(`/api/skills/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`skill ${res.status}`);
  return recordToSkill((await res.json()) as SkillRecord);
}

export interface SkillInput {
  name: string;
  kind?: SkillKind;
  description: string;
  tags: string[];
  sections: { overview: string[]; procedure: string[]; verify: string[] };
}

export async function createSkill(input: SkillInput): Promise<Skill> {
  const res = await backendFetch("/api/skills", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create skill ${res.status}`);
  return recordToSkill((await res.json()) as SkillRecord);
}

/** Edit a skill/playbook. A content change (name/description/sections) mints a
 *  new version server-side; a tags-only edit does not. */
export async function updateSkill(
  id: string,
  patch: Partial<Omit<SkillInput, "kind">>,
): Promise<Skill> {
  const res = await backendFetch(`/api/skills/${id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update skill ${res.status}`);
  return recordToSkill((await res.json()) as SkillRecord);
}

export async function deleteSkill(id: string): Promise<void> {
  const res = await backendFetch(`/api/skills/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete skill ${res.status}`);
}

/* -------------------------------------------------------------------------- */
/*  GitHub import (scan + import + per-skill resync)                            */
/* -------------------------------------------------------------------------- */

export interface SkillImportCandidate {
  path: string;
  name: string;
  description: string;
  sizeBytes: number;
  /** This org already imported this (repo, path). */
  alreadyImported: boolean;
}

export interface SkillScanResult {
  repo: string;
  sha: string;
  candidates: SkillImportCandidate[];
  /** SKILL.md files skipped for exceeding the size cap (surfaced, not silent). */
  skipped: { path: string; sizeBytes: number; reason: "too_large" }[];
  /** The repo tree or candidate set was cut off; the list may be incomplete. */
  truncated: boolean;
}

/** The SKILL.md files a repo offers (GET /api/skills/import/scan). */
export async function scanSkillImports(repo: string): Promise<SkillScanResult> {
  const res = await backendFetch(
    `/api/skills/import/scan?repo=${encodeURIComponent(repo)}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`scan skills ${res.status}`);
  return (await res.json()) as SkillScanResult;
}

export type SkillImportAction =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped"
  | "protected";

export interface SkillImportOutcome {
  path: string;
  action: SkillImportAction;
  reason?: "not_found" | "too_large";
  skillId?: string;
  version?: number;
}

/** Import (or resync - the same source-keyed upsert) SKILL.md paths from a
 *  repo's current HEAD (POST /api/skills/import). Unchanged content is a no-op. */
export async function importSkillPaths(
  repo: string,
  paths: string[],
): Promise<{ repo: string; sha: string; results: SkillImportOutcome[] }> {
  const res = await backendFetch("/api/skills/import", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ repo, paths }),
  });
  if (!res.ok) throw new Error(`import skills ${res.status}`);
  return (await res.json()) as {
    repo: string;
    sha: string;
    results: SkillImportOutcome[];
  };
}
