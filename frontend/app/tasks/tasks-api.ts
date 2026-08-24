import { backendFetch } from "@/lib/backend-fetch";
import type { Task, TaskStatus } from "./tasks-data";

/**
 * Thin fetch layer for the Tasks endpoints. Routing (backend origin + cookie
 * forwarding on the server, relative path on the client) lives in `backendFetch`.
 * Reads throw on a non-2xx so callers can surface a distinct "backend
 * unreachable" state instead of an empty board.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

/** List org tasks, optionally scoped to one project key. */
export async function fetchTasks(project?: string): Promise<Task[]> {
  const qs = project ? `?project=${encodeURIComponent(project)}` : "";
  const res = await backendFetch(`/api/tasks${qs}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`tasks ${res.status}`);
  const data = (await res.json()) as { tasks?: Task[] };
  return data.tasks ?? [];
}

/** The org's configured repositories (full names), used as project options. A
 *  failed fetch degrades to an empty list - the board still works with the
 *  project keys already present on tasks. */
export async function fetchRepoProjects(): Promise<string[]> {
  try {
    const res = await backendFetch("/api/repos", { cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { repos?: { full_name?: string }[] };
    return (data.repos ?? [])
      .map((r) => r.full_name)
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
