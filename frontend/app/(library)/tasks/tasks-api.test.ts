import { describe, expect, test } from "bun:test";
import { fetchTasks } from "./tasks-api";
import type { Task } from "./tasks-data";

function task(index: number): Task {
  return {
    id: `task-${index}`,
    project_key: null,
    title: `Task ${index}`,
    body: null,
    status: "todo",
    priority: 0,
    order: index,
    created_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-01T10:00:00.000Z",
  };
}

/** Answers each request with the next of `pages`, recording the paths asked for. */
function pagedFetcher(pages: ReadonlyArray<{ status?: number; body: unknown }>) {
  const paths: string[] = [];
  const fetcher = async (path: string) => {
    const page = pages[paths.length];
    paths.push(path);
    if (!page) throw new Error(`unexpected request ${path}`);
    return new Response(JSON.stringify(page.body), { status: page.status ?? 200 });
  };
  return { paths, fetcher: fetcher as never };
}

describe("fetchTasks", () => {
  test("reads every page, so a task past the first page is on the board", async () => {
    const first = Array.from({ length: 500 }, (_, index) => task(index));
    const { paths, fetcher } = pagedFetcher([
      { body: { tasks: first, has_more: true, next_cursor: "c1" } },
      { body: { tasks: [task(500)], has_more: false, next_cursor: null } },
    ]);
    const tasks = await fetchTasks(undefined, fetcher);
    expect(tasks).toHaveLength(501);
    expect(tasks.at(-1)?.id).toBe("task-500");
    expect(paths).toEqual([
      "/api/tasks?scope=all&exclude_archived=1&limit=500",
      "/api/tasks?scope=all&exclude_archived=1&limit=500&cursor=c1",
    ]);
  });

  test("scopes every page to the chosen project", async () => {
    const { paths, fetcher } = pagedFetcher([
      { body: { tasks: [task(1)], has_more: true, next_cursor: "a/b" } },
      { body: { tasks: [task(2)], has_more: false, next_cursor: null } },
    ]);
    await fetchTasks("acme/web app", fetcher);
    expect(paths).toEqual([
      "/api/tasks?project=acme%2Fweb%20app&exclude_archived=1&limit=500",
      "/api/tasks?project=acme%2Fweb%20app&exclude_archived=1&limit=500&cursor=a%2Fb",
    ]);
  });

  test("an answer without a cursor is the last page", async () => {
    const { paths, fetcher } = pagedFetcher([{ body: { tasks: [task(1)] } }]);
    expect(await fetchTasks(undefined, fetcher)).toHaveLength(1);
    expect(paths).toHaveLength(1);
  });

  test("a failed page fails the read instead of showing part of the board", async () => {
    const { fetcher } = pagedFetcher([
      { body: { tasks: [task(1)], has_more: true, next_cursor: "c1" } },
      { status: 503, body: { error: "unavailable" } },
    ]);
    await expect(fetchTasks(undefined, fetcher)).rejects.toThrow("tasks 503");
  });

  test("shows a task once when a move between pages returns it twice", async () => {
    const { fetcher } = pagedFetcher([
      { body: { tasks: [task(1), task(2)], next_cursor: "c1" } },
      { body: { tasks: [task(2), task(3)], next_cursor: null } },
    ]);
    const tasks = await fetchTasks(undefined, fetcher);
    expect(tasks.map((item) => item.id)).toEqual(["task-1", "task-2", "task-3"]);
  });

  test("stops when the same cursor comes back", async () => {
    const { fetcher } = pagedFetcher([
      { body: { tasks: [task(1)], next_cursor: "loop" } },
      { body: { tasks: [task(2)], next_cursor: "loop" } },
    ]);
    await expect(fetchTasks(undefined, fetcher)).rejects.toThrow("cursor repeated");
  });
});
