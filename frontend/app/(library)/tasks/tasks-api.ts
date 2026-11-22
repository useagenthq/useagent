import { backendFetch } from "@/lib/backend-fetch";
import type { Task, TaskStatus } from "./tasks-data";

/**
 * Thin fetch layer for the Tasks endpoints. Routing (backend origin + cookie
 * forwarding on the server, relative path on the client) lives in `backendFetch`.
 * Reads throw on a non-2xx so callers can surface a distinct "backend
 * unreachable" state instead of an empty board.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

/** The most tasks one request asks for; the backend caps a page at 500. */
const TASKS_PAGE_LIMIT = 500;

/** List org tasks, optionally scoped to one project key: every page, so the
 *  board and its column counts hold every open task. Archived tasks have no
 *  column and are left out by the backend. */
export async function fetchTasks(
  project?: string,
  fetcher: typeof backendFetch = backendFetch,
): Promise<Task[]> {
  const scope = project ? `project=${encodeURIComponent(project)}` : "scope=all";
  const base = `/api/tasks?${scope}&exclude_archived=1&limit=${TASKS_PAGE_LIMIT}`;
  const tasks = new Map<string, Task>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const path: string = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
    const res = await fetcher(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`tasks ${res.status}`);
    const data = (await res.json()) as { tasks?: Task[]; next_cursor?: string | null };
    // A card moved while the pages are read can come back on a later page;
    // the board shows it once, where it was first read.
    for (const task of data.tasks ?? []) if (!tasks.has(task.id)) tasks.set(task.id, task);
    cursor = typeof data.next_cursor === "string" ? data.next_cursor : null;
    // A cursor answered twice would never end the loop.
    if (cursor !== null && cursors.has(cursor)) throw new Error("tasks: cursor repeated");
    if (cursor !== null) cursors.add(cursor);
  } while (cursor !== null);
  return [...tasks.values()];
}

/** The org's durable project identities, used as board filter options. A failed
 *  fetch degrades to task project keys already present on the board. */
export async function fetchRepoProjects(): Promise<string[]> {
  try {
    const res = await backendFetch("/api/projects", { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      projects?: { key?: string; repo_full_name?: string | null }[];
    };
    return (data.projects ?? [])
      .map((project) => project.repo_full_name ?? project.key)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    return [];
  }
}

export interface CreateTaskInput {
  title: string;
  project_key?: string | null;
  body?: string | null;
  status?: TaskStatus;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const res = await backendFetch("/api/tasks", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create ${res.status}`);
  return (await res.json()) as Task;
}

export interface UpdateTaskPatch {
  title?: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: number;
  order?: number;
}

export async function updateTask(id: string, patch: UpdateTaskPatch): Promise<Task> {
  const res = await backendFetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update ${res.status}`);
  return (await res.json()) as Task;
}

export async function deleteTask(id: string): Promise<void> {
  const res = await backendFetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`delete ${res.status}`);
}
