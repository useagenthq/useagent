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

    // Org A sees both; org B sees neither (org-scoped).
    const listA = await json<{ tasks: any[] }>("/api/tasks", { cookies: a.cookies });
    const idsA = listA.body.tasks.map((t) => t.id);
    expect(idsA).toContain(web.body.id);
    expect(idsA).toContain(api.body.id);

    const listB = await json<{ tasks: any[] }>("/api/tasks", { cookies: b.cookies });
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
});
