import { describe, expect, test } from "bun:test";
import { createOrgSession, json, uid } from "./helpers";

interface ProjectWire {
  id: string;
  key: string;
  archived: boolean;
}

interface TaskWire {
  project_id: string | null;
  project_key: string | null;
}

describe("projects API", () => {
  test("creates durable org-scoped projects and archives without deleting identity", async () => {
    const owner = await createOrgSession("projects-owner");
    const outsider = await createOrgSession("projects-outsider");
    const key = `acme/project-${uid()}`;

    const created = await json<ProjectWire>("/api/projects", {
      method: "POST",
      cookies: owner.cookies,
      body: { key, display_name: "Project Alpha", repo_full_name: key },
    });
    expect(created.status).toBe(201);
    expect(created.body.key).toBe(key);

    const active = await json<{ projects: ProjectWire[] }>("/api/projects", {
      cookies: owner.cookies,
    });
    expect(active.body.projects.map((project) => project.id)).toContain(created.body.id);

    const hiddenFromOtherOrg = await json<{ projects: ProjectWire[] }>("/api/projects?scope=all", {
      cookies: outsider.cookies,
    });
    expect(hiddenFromOtherOrg.body.projects.map((project) => project.id)).not.toContain(
      created.body.id,
    );

    const archived = await json<ProjectWire>(`/api/projects/${created.body.id}`, {
      method: "PATCH",
      cookies: owner.cookies,
      body: { archived: true },
    });
    expect(archived.body.archived).toBe(true);

    const activeAfterArchive = await json<{ projects: ProjectWire[] }>("/api/projects", {
      cookies: owner.cookies,
    });
    expect(activeAfterArchive.body.projects.map((project) => project.id)).not.toContain(
      created.body.id,
    );
    const all = await json<{ projects: ProjectWire[] }>("/api/projects?scope=all", {
      cookies: owner.cookies,
    });
    expect(all.body.projects.map((project) => project.id)).toContain(created.body.id);
  });

  test("independent tasks stay explicitly unfiled", async () => {
    const session = await createOrgSession("projects-unfiled");
    const task = await json<TaskWire>("/api/tasks", {
      method: "POST",
      cookies: session.cookies,
      body: { title: "Independent task" },
    });
    expect(task.status).toBe(201);
    expect(task.body.project_id).toBeNull();
    expect(task.body.project_key).toBeNull();
  });
});
