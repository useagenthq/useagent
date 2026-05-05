/**
 * Playbook ("skill") types + helpers for the New Task composer's picker. The
 * list itself is fetched live from the backend (`GET /api/skills` on :3201) in
 * the page — see `fetchSkills` below — so the picker shows real playbooks with
 * a graceful empty-state fallback if the backend is unreachable.
 */
import { backendFetch } from "@/lib/backend-fetch";

export interface Skill {
  id: string;
  name: string;
  tags: string[];
}

function toSkill(value: unknown): Skill | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.name !== "string") return null;
  const tags = Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === "string") : [];
  return { id: s.id, name: s.name, tags };
}

/**
 * Live playbooks from `GET /api/skills`. The endpoint ships a `{ skills: [...] }`
 * envelope (a bare array is also accepted). Any failure yields `[]` so the
 * composer degrades to a "No playbook"-only picker rather than a broken one.
 */
export async function fetchSkills(): Promise<Skill[]> {
  try {
    const res = await backendFetch("/api/skills", { cache: "no-store" });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    const raw = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as { skills?: unknown }).skills)
        ? (data as { skills: unknown[] }).skills
        : [];
    return raw.map(toSkill).filter((s): s is Skill => s !== null);
  } catch {
    return [];
  }
}
