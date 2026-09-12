// ---------------------------------------------------------------------------
// Data behind the composer @-mention picker: the item shapes and the fetchers
// for skills, threads, pulls, bots, repos and the repo tree. UI-free so the
// picker component only renders and the hook only sequences.
// ---------------------------------------------------------------------------
import type { BotState } from "@useagent/agent-client";
import { botStatus } from "@/components/bots/bot-status";
import { runTitle } from "@/components/chat/types";
import { backendFetch } from "@/lib/backend-fetch";
import { relativeTime } from "@/utils/format";

/** A skill the caller already has (new-task composer); else the hook fetches. */
export type MentionSkill = { id: string; name: string; tag?: string };

export type Resource<T> = { status: "idle" | "loading" | "ready" | "error"; items: T[] };
export const IDLE: Resource<never> = { status: "idle", items: [] };

export type ThreadItem = { id: string; title: string; meta: string };
export type PullItem = { repo: string; number: number; title: string };
export type RepoItem = { full_name: string; private: boolean; default_branch: string | null };
export type TreeItem = { path: string; name: string; type: "file" | "dir" };
export type BotItem = { id: string; name: string; title: string; state: BotState; avatarTone: string; avatarIcon: string };

export { firstLine } from "./types";

export async function fetchThreads(): Promise<ThreadItem[]> {
  const res = await backendFetch("/api/runs?view=summary&limit=50");
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as {
    runs?: { id?: string; prompt?: string; created_at?: string | number; createdAt?: string | number }[];
  };
  const runs = Array.isArray(data.runs) ? data.runs : [];
  return runs
    .filter((r): r is { id: string; prompt?: string; created_at?: string | number; createdAt?: string | number } =>
      typeof r.id === "string",
    )
    .map((r) => ({
      id: r.id,
      title: runTitle(r.prompt),
      meta: relativeTime(r.created_at ?? r.createdAt ?? null),
    }));
}

export async function fetchPulls(): Promise<PullItem[]> {
  const res = await backendFetch("/api/pulls");
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as {
    pulls?: { repo?: string; number?: number; title?: string }[];
  };
  const pulls = Array.isArray(data.pulls) ? data.pulls : [];
  return pulls
    .filter((p): p is { repo: string; number: number; title?: string } =>
      typeof p.repo === "string" && typeof p.number === "number",
    )
    .map((p) => ({ repo: p.repo, number: p.number, title: p.title ?? "" }));
}

export async function fetchBots(): Promise<BotItem[]> {
  const res = await backendFetch("/api/bots");
  if (!res.ok) throw new Error(`bots ${res.status}`);
  const data = (await res.json()) as {
    bots?: { id: string; name: string; title: string; archived?: boolean; state?: unknown; avatarTone: string; avatarIcon: string }[];
  };
  return (data.bots ?? []).filter((b) => !b.archived).map((b) => ({
    id: b.id,
    name: b.name,
    title: b.title,
    state: botStatus(b.state).state,
    avatarTone: b.avatarTone,
    avatarIcon: b.avatarIcon,
  }));
}

export async function fetchRepos(): Promise<RepoItem[]> {
  const res = await backendFetch("/api/repos");
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as {
    repos?: { full_name?: string; private?: boolean; default_branch?: string }[];
  };
  const repos = Array.isArray(data.repos) ? data.repos : [];
  return repos
    .filter((r): r is { full_name: string; private?: boolean; default_branch?: string } =>
      typeof r.full_name === "string",
    )
    .map((r) => ({
      full_name: r.full_name,
      private: Boolean(r.private),
      default_branch: typeof r.default_branch === "string" ? r.default_branch : null,
    }));
}

export function repoTreeUrl(repo: string, revision: string | null, dir: string): string {
  const params = new URLSearchParams();
  if (revision) params.set("ref", revision);
  if (dir) params.set("path", dir);
  return `/api/repos/${repo}/tree${params.size ? `?${params.toString()}` : ""}`;
}

export async function fetchTree(repo: string, revision: string | null, dir: string): Promise<TreeItem[]> {
  const res = await backendFetch(repoTreeUrl(repo, revision, dir));
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as { entries?: { path?: string; type?: string }[] };
  const entries = Array.isArray(data.entries) ? data.entries : [];
  return entries
    .filter((e): e is { path: string; type?: string } => typeof e.path === "string")
    .map((e) => ({
      path: e.path,
      name: e.path.split("/").pop() ?? e.path,
      type: e.type === "dir" ? "dir" : "file",
    }));
}

/** Order the caller's already-selected repos first, then the rest. */
export function orderRepos(repos: RepoItem[], selected: readonly string[] | undefined): RepoItem[] {
  if (!selected || selected.length === 0) return repos;
  const set = new Set(selected);
  return [...repos.filter((r) => set.has(r.full_name)), ...repos.filter((r) => !set.has(r.full_name))];
}

export async function fetchSkillsPicker(): Promise<MentionSkill[]> {
  const res = await backendFetch("/api/skills?view=picker&limit=2000");
  if (!res.ok) throw new Error(String(res.status));
  const data = (await res.json()) as {
    skills?: { id?: string; name?: string; tags?: string[] }[];
  };
  const list = Array.isArray(data.skills) ? data.skills : [];
  return list
    .filter((s): s is { id: string; name: string; tags?: string[] } =>
      typeof s.id === "string" && typeof s.name === "string",
    )
    .map((s) => ({ id: s.id, name: s.name, tag: s.tags?.[0] }));
}
