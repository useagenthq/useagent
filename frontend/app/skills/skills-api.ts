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
