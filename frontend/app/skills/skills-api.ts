import { backendFetch } from "@/lib/backend-fetch";
import { recordToSkill, type Skill, type SkillRecord } from "./skills-data";

/**
 * Thin fetch layer for the skills endpoints. Routing (backend origin + cookie
 * forwarding on the server, relative path on the client) lives in
 * `backendFetch`. Every call throws on a non-2xx so callers can fall back to
 * mock data or revert an optimistic update.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

export async function fetchSkills(): Promise<Skill[]> {
  const res = await backendFetch("/api/skills", { cache: "no-store" });
  if (!res.ok) throw new Error(`skills ${res.status}`);
  const data = (await res.json()) as { skills?: SkillRecord[] };
  return (data.skills ?? []).map(recordToSkill);
}

export interface CreateSkillInput {
  name: string;
  description: string;
  tags: string[];
  sections: { overview: string[]; procedure: string[]; verify: string[] };
}

export async function createSkill(input: CreateSkillInput): Promise<Skill> {
  const res = await backendFetch("/api/skills", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create skill ${res.status}`);
  return recordToSkill((await res.json()) as SkillRecord);
}

export async function runSkill(id: string): Promise<Skill> {
  const res = await backendFetch(`/api/skills/${id}/run`, { method: "POST" });
  if (!res.ok) throw new Error(`run skill ${res.status}`);
  return recordToSkill((await res.json()) as SkillRecord);
}
