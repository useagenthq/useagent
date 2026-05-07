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
  /** Which surface this belongs to - lets the picker group Skills vs Playbooks. */
  kind: "skill" | "playbook";
  tags: string[];
  /** The skill's current immutable revision - sent with the run so the backend
   *  pins the exact version this composer offered. Defaults to 1. */
  version: number;
}

function toSkill(value: unknown): Skill | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.name !== "string") return null;
  const tags = Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === "string") : [];
  const version =
    typeof s.current_version === "number" && s.current_version > 0 ? s.current_version : 1;
  const kind = s.kind === "playbook" ? "playbook" : "skill";
  return { id: s.id, name: s.name, kind, tags, version };
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
