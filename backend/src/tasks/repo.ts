import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { tasks, type TaskStatus } from "../db/schema";

// ---------------------------------------------------------------------------
// Tasks data access. Every function is ORG-SCOPED and fail-closed: a cross-org
// (or missing) id resolves to null. The board reads through `listTasksForOrg`
// (optionally filtered to one project); the gateway tools and REST routes share
// this one module so there is a single place tenancy is enforced.
// ---------------------------------------------------------------------------

export type TaskRecord = typeof tasks.$inferSelect;

export interface CreateTaskInput {
  orgId: string;
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
async function nextOrderKey(orgId: string, projectKey: string | null): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${tasks.orderKey})` })
    .from(tasks)
    .where(
      and(
        eq(tasks.orgId, orgId),
        projectKey === null
          ? sql`${tasks.projectKey} is null`
          : eq(tasks.projectKey, projectKey),
      ),
    );
  return (row?.max ?? 0) + 1;
}

/** Create an org-scoped task. `projectKey` normalizes an empty string to null. */
export async function createTask(input: CreateTaskInput): Promise<TaskRecord> {
  const projectKey =
    input.projectKey && input.projectKey.trim() ? input.projectKey.trim() : null;
  const orderKey = await nextOrderKey(input.orgId, projectKey);
  const [row] = await db
    .insert(tasks)
    .values({
      orgId: input.orgId,
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

/** List org-scoped tasks, newest-column-order first. When `projectKey` is
 *  provided the list is scoped to that project ("" / null → the unfiled column);
 *  omit it (undefined) to list every task in the org. Ordered by column position
 *  then recency so the board can group by status directly. */
export async function listTasksForOrg(
  orgId: string,
  projectKey?: string | null,
): Promise<TaskRecord[]> {
  const scope =
    projectKey === undefined
      ? eq(tasks.orgId, orgId)
      : and(
          eq(tasks.orgId, orgId),
          projectKey === null || projectKey === ""
            ? sql`${tasks.projectKey} is null`
            : eq(tasks.projectKey, projectKey),
        );
  return db
    .select()
    .from(tasks)
    .where(scope)
    .orderBy(asc(tasks.orderKey), desc(tasks.createdAt), desc(tasks.id));
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
