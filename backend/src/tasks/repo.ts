import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { tasks, type TaskStatus } from "../db/schema";
import { ensureProject, getProjectForOrg } from "../projects/repo";

// ---------------------------------------------------------------------------
// Tasks data access. Every function is ORG-SCOPED and fail-closed: a cross-org
// (or missing) id resolves to null. The board reads through `listTasksForOrg`
// (optionally filtered to one project); the gateway tools and REST routes share
// this one module so there is a single place tenancy is enforced.
// ---------------------------------------------------------------------------

export type TaskRecord = typeof tasks.$inferSelect;

export interface CreateTaskInput {
  orgId: string;
  projectId?: string | null;
  projectKey?: string | null;
  title: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: number;
  createdByUserId?: string | null;
  sourceRunId?: string | null;
}

export interface UpdateTaskPatch {
  title?: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: number;
  /** New ordering position within a column (see `orderKey`). */
  order?: number;
}

/** Next append-to-bottom order key for a project: one above the current max, so
 *  a freshly created task sorts last and a later reorder can drop cards between
 *  neighbours by taking their midpoint. Org+project scoped. */
async function nextOrderKey(orgId: string, projectId: string | null): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${tasks.orderKey})` })
    .from(tasks)
    .where(
      and(
        eq(tasks.orgId, orgId),
        projectId === null
          ? sql`${tasks.projectId} is null`
          : eq(tasks.projectId, projectId),
      ),
    );
  return (row?.max ?? 0) + 1;
}

/** Create an org-scoped task. `projectKey` normalizes an empty string to null. */
export async function createTask(input: CreateTaskInput): Promise<TaskRecord> {
  const requestedKey = input.projectKey?.trim() || null;
  const selectedProject = input.projectId
    ? await getProjectForOrg(input.orgId, input.projectId)
    : requestedKey
      ? await ensureProject(input.orgId, requestedKey, {
          repoFullName: requestedKey.includes("/") ? requestedKey : null,
        })
      : null;
  if (input.projectId && !selectedProject) throw new Error("project not found");
  const projectId = selectedProject?.id ?? null;
  const projectKey = selectedProject?.key ?? null;
  const orderKey = await nextOrderKey(input.orgId, projectId);
  const [row] = await db
    .insert(tasks)
    .values({
      orgId: input.orgId,
      projectId,
      projectKey,
      title: input.title,
      body: input.body ?? null,
      status: input.status ?? "todo",
      priority: input.priority ?? 0,
      orderKey,
      createdByUserId: input.createdByUserId ?? null,
      sourceRunId: input.sourceRunId ?? null,
    })
    .returning();
  return row!;
}

/** List org-scoped tasks with an explicit scope and hard upper bound. The
 * default is the unfiled project; cross-project reads require `{ scope: "all" }`.
 * Ordered by column position then recency for direct board grouping. */
export type TaskListScope =
  | { scope: "all" }
  | { projectId: string }
  | { projectKey: string | null };

export async function listTasksForOrg(
  orgId: string,
  selection: TaskListScope = { projectKey: null },
  requestedLimit = 100,
): Promise<TaskRecord[]> {
  const limit = Math.min(Math.max(requestedLimit, 1), 500);
  const projectScope =
    "scope" in selection
      ? undefined
      : "projectId" in selection
        ? eq(tasks.projectId, selection.projectId)
        : selection.projectKey === null || selection.projectKey === ""
          ? sql`${tasks.projectId} is null`
          : eq(tasks.projectKey, selection.projectKey);
  const scope = projectScope
    ? and(eq(tasks.orgId, orgId), projectScope)
    : eq(tasks.orgId, orgId);
  return db
    .select()
    .from(tasks)
    .where(scope)
    .orderBy(asc(tasks.orderKey), desc(tasks.createdAt), desc(tasks.id))
    .limit(limit);
}

/** Org-scoped fetch - a cross-org (or missing) id resolves to null. */
export async function getTaskForOrg(orgId: string, id: string): Promise<TaskRecord | null> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/** Update a task (partial, org-scoped). Only the provided fields change; `order`
 *  maps to the float `order_key`. Returns the updated row, or null if the id is
 *  not in the org. */
export async function updateTask(
  orgId: string,
  id: string,
  patch: UpdateTaskPatch,
): Promise<TaskRecord | null> {
  const set: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.body !== undefined) set.body = patch.body;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.order !== undefined) set.orderKey = patch.order;
  const [row] = await db
    .update(tasks)
    .set(set)
    .where(and(eq(tasks.id, id), eq(tasks.orgId, orgId)))
    .returning();
  return row ?? null;
}

/** Delete a task (org-scoped). Returns the deleted id, or null if not found. */
export async function deleteTask(orgId: string, id: string): Promise<string | null> {
  const [row] = await db
    .delete(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.orgId, orgId)))
    .returning({ id: tasks.id });
  return row?.id ?? null;
}
