import { Hono } from "hono";
import { TASK_STATUSES, type TaskStatus } from "../db/schema";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import {
  createTask,
  deleteTask,
  listTasksForOrg,
  updateTask,
  type TaskRecord,
} from "./repo";

export const tasksRoutes = new Hono<AppEnv>();

tasksRoutes.use("*", orgScope);

function toTask(t: TaskRecord) {
  return {
    id: t.id,
    org_id: t.orgId,
    project_id: t.projectId,
    // The repo full_name ("owner/name") or free label this task is filed under.
    project_key: t.projectKey,
    title: t.title,
    body: t.body,
    // 'todo' | 'in_progress' | 'done' | 'archived' - the Kanban column.
    status: t.status,
    priority: t.priority,
    order: t.orderKey,
    created_by_user_id: t.createdByUserId,
    source_run_id: t.sourceRunId,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
  };
}

function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);
}

// List tasks for the active org. `?project=<key>` or `?project_id=<uuid>` scopes
// to one project; the default is unfiled, and `?scope=all` is the explicit
// bounded cross-project read.
tasksRoutes.get("/", async (c) => {
  const project = c.req.query("project");
  const projectId = c.req.query("project_id");
  const rawLimit = Number(c.req.query("limit") ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 100;
  const selection =
    c.req.query("scope") === "all"
      ? ({ scope: "all" } as const)
      : projectId
        ? ({ projectId } as const)
        : ({ projectKey: project ?? null } as const);
  const rows = await listTasksForOrg(c.get("orgId"), selection, limit);
  return c.json({ tasks: rows.map(toTask) });
});

// Create a task (org-scoped). `title` is required; `status` defaults to "todo".
tasksRoutes.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return c.json({ error: "title is required" }, 400);

  let status: TaskStatus | undefined;
  if (body.status !== undefined) {
    if (!isTaskStatus(body.status)) {
      return c.json({ error: `status must be one of: ${TASK_STATUSES.join(", ")}` }, 400);
    }
    status = body.status;
  }

  let row: TaskRecord;
  try {
    row = await createTask({
      orgId: c.get("orgId"),
      projectId: typeof body.project_id === "string" ? body.project_id : null,
      projectKey: typeof body.project_key === "string" ? body.project_key : null,
      title,
      body: typeof body.body === "string" ? body.body : null,
      status,
      priority: typeof body.priority === "number" ? body.priority : undefined,
      createdByUserId: c.get("userId") ?? null,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message === "project not found") {
      return c.json({ error: cause.message }, 404);
    }
    throw cause;
  }
  return c.json(toTask(row), 201);
});

// Update a task (partial). Any subset of title/body/status/priority/order.
tasksRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const patch: {
    title?: string;
    body?: string | null;
    status?: TaskStatus;
    priority?: number;
    order?: number;
  } = {};
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
  if (body.body !== undefined) patch.body = typeof body.body === "string" ? body.body : null;
  if (body.status !== undefined) {
    if (!isTaskStatus(body.status)) {
      return c.json({ error: `status must be one of: ${TASK_STATUSES.join(", ")}` }, 400);
    }
    patch.status = body.status;
  }
  if (typeof body.priority === "number") patch.priority = body.priority;
  if (typeof body.order === "number") patch.order = body.order;

  const row = await updateTask(c.get("orgId"), id, patch);
  if (!row) return c.json({ error: "task not found" }, 404);
  return c.json(toTask(row));
});

// Delete a task (org-scoped).
tasksRoutes.delete("/:id", async (c) => {
  const deletedId = await deleteTask(c.get("orgId"), c.req.param("id"));
  if (!deletedId) return c.json({ error: "task not found" }, 404);
  return c.json({ deleted: true, id: deletedId });
});
