import { describe, expect, test } from "bun:test";
import { createOrgSession, json, uid } from "./helpers";

describe("tasks CRUD (org-scoped) + project filter", () => {
  test("create -> org-scoped list -> project filter -> status update -> delete -> 404", async () => {
    const a = await createOrgSession("tasks-a");
    const b = await createOrgSession("tasks-b");
    const projectWeb = `acme/web-${uid()}`;
    const projectApi = `acme/api-${uid()}`;

    // Create two tasks in org A under different projects.
    const web = await json<any>("/api/tasks", {
      method: "POST",
      cookies: a.cookies,
      body: { title: "Ship the board", project_key: projectWeb, body: "first" },
    });
    expect(web.status).toBe(201);
    expect(web.body.id).toBeTruthy();
    expect(web.body.status).toBe("todo");
    expect(web.body.project_key).toBe(projectWeb);
    expect(web.body.priority).toBe(0);
    expect(typeof web.body.created_at).toBe("string");

    const api = await json<any>("/api/tasks", {
      method: "POST",
      cookies: a.cookies,
      body: { title: "Wire the API", project_key: projectApi, status: "in_progress" },
    });
    expect(api.status).toBe(201);
    expect(api.body.status).toBe("in_progress");

    // Cross-project listing is explicit; the default scope is unfiled only.
    const defaultScope = await json<{ tasks: any[] }>("/api/tasks", {
      cookies: a.cookies,
    });
    expect(defaultScope.body.tasks).toHaveLength(0);

    // Org A sees both when explicitly requesting all; org B sees neither.
    const listA = await json<{ tasks: any[] }>("/api/tasks?scope=all", { cookies: a.cookies });
    const idsA = listA.body.tasks.map((t) => t.id);
    expect(idsA).toContain(web.body.id);
    expect(idsA).toContain(api.body.id);
    const bounded = await json<{ tasks: any[] }>("/api/tasks?scope=all&limit=1", {
      cookies: a.cookies,
    });
    expect(bounded.body.tasks).toHaveLength(1);

    const listB = await json<{ tasks: any[] }>("/api/tasks?scope=all", { cookies: b.cookies });
    const idsB = listB.body.tasks.map((t) => t.id);
    expect(idsB).not.toContain(web.body.id);
    expect(idsB).not.toContain(api.body.id);

    // Project filter scopes to one project.
    const filtered = await json<{ tasks: any[] }>(
      `/api/tasks?project=${encodeURIComponent(projectWeb)}`,
      { cookies: a.cookies },
    );
    const filteredIds = filtered.body.tasks.map((t) => t.id);
    expect(filteredIds).toContain(web.body.id);
    expect(filteredIds).not.toContain(api.body.id);

    // Status update transitions the column.
    const moved = await json<any>(`/api/tasks/${web.body.id}`, {
      method: "PATCH",
      cookies: a.cookies,
      body: { status: "done", title: "Ship the board v2" },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.status).toBe("done");
    expect(moved.body.title).toBe("Ship the board v2");

    // Cross-org PATCH/DELETE fail closed (404).
    const crossPatch = await json<any>(`/api/tasks/${web.body.id}`, {
      method: "PATCH",
      cookies: b.cookies,
      body: { status: "archived" },
    });
    expect(crossPatch.status).toBe(404);
    const crossDelete = await json<any>(`/api/tasks/${web.body.id}`, {
      method: "DELETE",
      cookies: b.cookies,
    });
    expect(crossDelete.status).toBe(404);

    // Delete in org A, then it is gone.
    const del = await json<any>(`/api/tasks/${web.body.id}`, {
      method: "DELETE",
      cookies: a.cookies,
    });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true, id: web.body.id });

    const afterDelete = await json<any>(`/api/tasks/${web.body.id}`, {
      method: "PATCH",
      cookies: a.cookies,
      body: { status: "todo" },
    });
    expect(afterDelete.status).toBe(404);
  });

  test("POST /api/tasks requires a title; invalid status is a 400", async () => {
    const noTitle = await json<any>("/api/tasks", { method: "POST", body: {} });
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.error).toBeDefined();

    const badStatus = await json<any>("/api/tasks", {
      method: "POST",
      body: { title: "x", status: "backlog" },
    });
    expect(badStatus.status).toBe(400);
  });

  test("PATCH/DELETE unknown id -> 404", async () => {
    const missing = crypto.randomUUID();
    const patch = await json(`/api/tasks/${missing}`, {
      method: "PATCH",
      body: { status: "done" },
    });
    expect(patch.status).toBe(404);
    const del = await json(`/api/tasks/${missing}`, { method: "DELETE" });
    expect(del.status).toBe(404);
  });

  test("pages past 100 tasks with next_cursor, and leaves archived tasks out on request", async () => {
    const session = await createOrgSession("tasks-pages");
    const created: string[] = [];
    for (let index = 0; index < 103; index += 1) {
      const task = await json<any>("/api/tasks", {
        method: "POST",
        cookies: session.cookies,
        body: { title: `Task ${index}`, status: index < 2 ? "archived" : "todo" },
      });
      expect(task.status).toBe(201);
      created.push(task.body.id);
    }
    const newest = created.at(-1);

    const first = await json<any>("/api/tasks?scope=all", { cookies: session.cookies });
    expect(first.body.tasks).toHaveLength(100);
    expect(first.body.tasks.map((task: any) => task.id)).not.toContain(newest);
    expect(first.body.has_more).toBe(true);
    expect(typeof first.body.next_cursor).toBe("string");
    const second = await json<any>(
      `/api/tasks?scope=all&cursor=${encodeURIComponent(first.body.next_cursor)}`,
      { cookies: session.cookies },
    );
    expect(second.body.tasks.map((task: any) => task.title)).toEqual(["Task 100", "Task 101", "Task 102"]);
    expect(second.body).toMatchObject({ has_more: false, next_cursor: null });

    // Without the two archived tasks, the board's 101 open tasks still need two pages.
    const board = await json<any>("/api/tasks?scope=all&exclude_archived=1", { cookies: session.cookies });
    expect(board.body.tasks[0].title).toBe("Task 2");
    expect(board.body.tasks.every((task: any) => task.status !== "archived")).toBe(true);
    const boardRest = await json<any>(
      `/api/tasks?scope=all&exclude_archived=1&cursor=${encodeURIComponent(board.body.next_cursor)}`,
      { cookies: session.cookies },
    );
    expect(boardRest.body.tasks.map((task: any) => task.id)).toEqual([newest]);
    expect(boardRest.body.has_more).toBe(false);
  });

  test("an invalid cursor is a 400", async () => {
    const session = await createOrgSession("tasks-cursor");
    for (const cursor of ["", "nope!", Buffer.from("[1]").toString("base64url")]) {
      const response = await json<any>(`/api/tasks?scope=all&cursor=${encodeURIComponent(cursor)}`, {
        cookies: session.cookies,
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("cursor is invalid");
    }
  });
});
