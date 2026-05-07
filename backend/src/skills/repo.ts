import { and, eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { skillRevisions, skills, type SkillSections } from "../db/schema";
import { formatSkillMarkdown, hashSkillContent, type SkillContent } from "./format";

// ---------------------------------------------------------------------------
// Skills data access (mem_op 0.1). The `skills` row holds the LATEST content +
// `current_version`; `skill_revisions` is the immutable history. Create/edit
// commit the row + its revision in ONE transaction so a version always has a
// matching revision. Runs pin a (skill_id, version) reference, never the row —
// so a later edit can't rewrite a historical run's loaded content.
// ---------------------------------------------------------------------------

export type SkillRecord = typeof skills.$inferSelect;
export type SkillRevisionRecord = typeof skillRevisions.$inferSelect;

/** A resolved, pinned skill revision — everything a run needs to materialize and
 *  attribute the skill it loaded. */
export interface PinnedSkill {
  skillId: string;
  version: number;
  contentHash: string;
  content: SkillContent;
}

/** Append the immutable revision row for a skill version (inside a tx). */
async function insertRevision(
  exec: Executor,
  skillId: string,
  version: number,
  content: SkillContent,
): Promise<string> {
  const contentHash = hashSkillContent(formatSkillMarkdown(content));
  await exec.insert(skillRevisions).values({
    skillId,
    version,
    name: content.name,
    description: content.description,
    sections: content.sections,
    contentHash,
  });
  return contentHash;
}

/**
 * Create a skill AND its version-1 revision atomically. `onConflictDoNothing` on
 * (org, name) makes it safe for the idempotent seeder; a genuine duplicate from
 * the API surfaces as null (→ 409). Returns the created row, or null on conflict.
 */
export async function createSkillWithRevision(input: {
  orgId: string;
  name: string;
  description: string;
  tags: string[];
  sections: SkillSections;
  usageCount?: number;
  lastRunAt?: Date | null;
}): Promise<SkillRecord | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(skills)
      .values({
        orgId: input.orgId,
        name: input.name,
        description: input.description,
        tags: input.tags,
        sections: input.sections,
        currentVersion: 1,
        usageCount: input.usageCount ?? 0,
        lastRunAt: input.lastRunAt ?? null,
      })
      .onConflictDoNothing({ target: [skills.orgId, skills.name] })
      .returning();
    if (!row) return null; // (org, name) already exists
    await insertRevision(tx, row.id, 1, {
      name: row.name,
      description: row.description,
      sections: row.sections,
    });
    return row;
  });
}

/**
 * Edit a skill (org-scoped) and, when the instruction content actually changes,
 * bump `current_version` and append a new immutable revision — all in one
 * transaction. Content-change is decided by comparing the new formatted-content
 * hash against the current revision's, so a tags-only edit (or a no-op) does not
 * mint a version. Returns the updated row, or null if it isn't in the org.
 */
export async function updateSkillWithRevision(
  orgId: string,
  id: string,
  patch: {
    name?: string;
    description?: string;
    tags?: string[];
    sections?: SkillSections;
  },
): Promise<SkillRecord | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(skills)
      .where(and(eq(skills.id, id), eq(skills.orgId, orgId)))
      .limit(1);
    if (!current) return null;

    const nextContent: SkillContent = {
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      sections: patch.sections ?? current.sections,
    };
    const nextHash = hashSkillContent(formatSkillMarkdown(nextContent));
    const [currentRev] = await tx
      .select({ hash: skillRevisions.contentHash })
      .from(skillRevisions)
      .where(
        and(
          eq(skillRevisions.skillId, id),
          eq(skillRevisions.version, current.currentVersion),
        ),
      )
      .limit(1);
    const contentChanged = !currentRev || currentRev.hash !== nextHash;
    const nextVersion = contentChanged
      ? current.currentVersion + 1
      : current.currentVersion;

    const [row] = await tx
      .update(skills)
      .set({
        name: nextContent.name,
        description: nextContent.description,
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        sections: nextContent.sections,
        currentVersion: nextVersion,
        updatedAt: new Date(),
      })
      .where(and(eq(skills.id, id), eq(skills.orgId, orgId)))
      .returning();
    if (contentChanged && row) {
      await insertRevision(tx, row.id, nextVersion, nextContent);
    }
    return row ?? null;
  });
}

/** Org-scoped fetch — a cross-org (or missing) id resolves to null. */
export async function getSkillForOrg(
  orgId: string,
  id: string,
): Promise<SkillRecord | null> {
  const [row] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, id), eq(skills.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve a composer skill selection ({ id, version? }) to a pinned revision,
 * ORG-SCOPED and fail-closed: an unknown skill, a cross-org id, or a missing
 * version all return null (the caller rejects). When `version` is omitted the
 * skill's current version is pinned.
 */
export async function resolveSkillSelection(
  orgId: string,
  sel: { id: string; version?: number },
): Promise<PinnedSkill | null> {
  const skill = await getSkillForOrg(orgId, sel.id);
  if (!skill) return null;
  const version = sel.version ?? skill.currentVersion;
  return getPinnedRevision(skill.id, version);
}

/**
 * Fetch a pinned revision by its (skillId, version) reference — the worker's path
 * to materialize what a run already resolved at creation. No org scope: the run
 * enforced it, and the reference is immutable.
 */
export async function getPinnedRevision(
  skillId: string,
  version: number,
): Promise<PinnedSkill | null> {
  const [rev] = await db
    .select()
    .from(skillRevisions)
    .where(
      and(eq(skillRevisions.skillId, skillId), eq(skillRevisions.version, version)),
    )
    .limit(1);
  if (!rev) return null;
  return {
    skillId,
    version: rev.version,
    contentHash: rev.contentHash,
    content: { name: rev.name, description: rev.description, sections: rev.sections },
  };
}

/**
 * Ensure a revision row exists for a skill's CURRENT version — idempotent backfill
 * for skills created before revisions existed (the live dev seed). A no-op when the
 * revision is already present (onConflictDoNothing on the (skill, version) index).
 */
export async function ensureCurrentRevision(
  orgId: string,
  name: string,
): Promise<void> {
  const [skill] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.orgId, orgId), eq(skills.name, name)))
    .limit(1);
  if (!skill) return;
  const contentHash = hashSkillContent(
    formatSkillMarkdown({
      name: skill.name,
      description: skill.description,
      sections: skill.sections,
    }),
  );
  await db
    .insert(skillRevisions)
    .values({
      skillId: skill.id,
      version: skill.currentVersion,
      name: skill.name,
      description: skill.description,
      sections: skill.sections,
      contentHash,
    })
    .onConflictDoNothing({
      target: [skillRevisions.skillId, skillRevisions.version],
    });
}

/** Bump usage_count + last_run_at (org-scoped). Returns the updated row or null. */
export async function bumpSkillUsage(
  orgId: string,
  id: string,
): Promise<SkillRecord | null> {
  const [row] = await db
    .update(skills)
    .set({
      usageCount: sql`${skills.usageCount} + 1`,
      lastRunAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(skills.id, id), eq(skills.orgId, orgId)))
    .returning();
  return row ?? null;
}
