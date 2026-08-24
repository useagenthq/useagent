import { and, asc, eq } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { projects } from "../db/schema";

export type ProjectRecord = typeof projects.$inferSelect;

export function normalizeProjectKey(value: string): string {
  return value.trim();
}

function defaultDisplayName(key: string): string {
  return key.split("/").at(-1) || key;
}

/** Resolve-or-create one org-owned project. The org/key uniqueness constraint
 * makes concurrent run acceptance converge on the same durable identity. */
export async function ensureProject(
  orgId: string,
  keyInput: string,
  options: { displayName?: string; repoFullName?: string | null } = {},
  exec: Executor = db,
): Promise<ProjectRecord> {
  const key = normalizeProjectKey(keyInput);
  if (!key) throw new Error("project key is required");
  const displayName = options.displayName?.trim() || defaultDisplayName(key);
  const repoFullName = options.repoFullName?.trim() || null;

  if (repoFullName) {
    const [byRepo] = await exec
      .select()
      .from(projects)
      .where(
        and(eq(projects.orgId, orgId), eq(projects.repoFullName, repoFullName)),
      )
      .limit(1);
    if (byRepo) return byRepo;
  }

  await exec
    .insert(projects)
    .values({ orgId, key, displayName, repoFullName })
    .onConflictDoNothing();

  const [byKey] = await exec
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.key, key)))
    .limit(1);
  const row =
    byKey ??
    (repoFullName
      ? (
          await exec
            .select()
            .from(projects)
            .where(
              and(eq(projects.orgId, orgId), eq(projects.repoFullName, repoFullName)),
            )
            .limit(1)
        )[0]
      : null);
  if (!row) throw new Error(`failed to resolve project ${key}`);

  if (repoFullName && row.repoFullName !== repoFullName) {
    const [updated] = await exec
      .update(projects)
      .set({ repoFullName, updatedAt: new Date() })
      .where(and(eq(projects.id, row.id), eq(projects.orgId, orgId)))
      .returning();
    return updated ?? row;
  }
  return row;
}

export async function getProjectForOrg(
  orgId: string,
  id: string,
  exec: Executor = db,
): Promise<ProjectRecord | null> {
  const [row] = await exec
    .select()
    .from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, id)))
    .limit(1);
  return row ?? null;
}

export async function listProjectsForOrg(
  orgId: string,
  options: { includeArchived?: boolean; limit?: number } = {},
): Promise<ProjectRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const scope = options.includeArchived
    ? eq(projects.orgId, orgId)
    : and(eq(projects.orgId, orgId), eq(projects.archived, false));
  return db
    .select()
    .from(projects)
    .where(scope)
    .orderBy(asc(projects.sortOrder), asc(projects.displayName), asc(projects.id))
    .limit(limit);
}

export async function updateProjectForOrg(
  orgId: string,
  id: string,
  patch: {
    displayName?: string;
    archived?: boolean;
    sortOrder?: number;
  },
): Promise<ProjectRecord | null> {
  const set: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.archived !== undefined) set.archived = patch.archived;
  if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
  const [row] = await db
    .update(projects)
    .set(set)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, id)))
    .returning();
  return row ?? null;
}
