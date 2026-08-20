import { and, eq, isNotNull } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { skillRevisions, skills, type SkillKind } from "../db/schema";
import { formatSkillMarkdown, hashSkillContent, type SkillContent } from "./format";
import type { SkillRecord } from "./repo";

// ---------------------------------------------------------------------------
// Source-keyed data access for GitHub-imported skills. A skill imported from a
// repo is identified by (org_id, source_repo, source_path) — NOT by name — so a
// re-import resolves the same row regardless of a display-name collision. The
// skill's `name` is the stable, org-unique identity fixed at first import; the
// TRACKED content is description + sections. Re-import compares the newly parsed
// content (rendered under the stable name) against the current revision's hash:
// unchanged -> no-op; changed -> append an immutable revision, bump the version,
// and advance source_sha to the commit read. Mirrors the create/edit atomicity
// of src/skills/repo.ts, keyed by source instead of by name/id.
// ---------------------------------------------------------------------------

export interface ImportUpsertOutcome {
  action: "created" | "updated" | "unchanged" | "protected";
  skillId: string;
  version: number;
}

/** Append an immutable revision row (inside a tx). The rendered SKILL.md hash is
 *  the addressable identity `skill.loaded` reports and re-imports compare on. */
async function writeRevision(
  exec: Executor,
  skillId: string,
  version: number,
  kind: SkillKind,
  content: SkillContent,
): Promise<void> {
  await exec.insert(skillRevisions).values({
    skillId,
    version,
    kind,
    name: content.name,
    description: content.description,
    sections: content.sections,
    contentHash: hashSkillContent(formatSkillMarkdown(content)),
  });
}

/** The set of source paths already imported from `repo` into this org — powers
 *  the scan's `alreadyImported` flag in one query. */
export async function listImportedPaths(
  orgId: string,
  repo: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ path: skills.sourcePath })
    .from(skills)
    .where(
      and(
        eq(skills.orgId, orgId),
        eq(skills.sourceRepo, repo),
        isNotNull(skills.sourcePath),
      ),
    );
  return new Set(rows.map((r) => r.path).filter((p): p is string => Boolean(p)));
}

/** Create a new imported skill + its version-1 revision, assigning the first
 *  org-unique name from a small deterministic ladder (bare source name, then
 *  qualified by repo / path / short sha). Runs inside the caller's tx. */
async function createImportedSkill(
  tx: Executor,
  input: {
    orgId: string;
    sourceRepo: string;
    sourcePath: string;
    commitSha: string;
    content: SkillContent;
  },
): Promise<SkillRecord> {
  const base = input.content.name.trim() || input.sourcePath;
  const repoName = input.sourceRepo.split("/")[1] ?? input.sourceRepo;
  const candidateNames = [
    base,
    `${base} (${repoName})`,
    `${base} (${input.sourcePath})`,
    `${base} (${input.commitSha.slice(0, 7)})`,
  ];

  for (const name of candidateNames) {
    const content: SkillContent = {
      name,
      description: input.content.description,
      sections: input.content.sections,
    };
    const [row] = await tx
      .insert(skills)
      .values({
        orgId: input.orgId,
        name,
        kind: "skill",
        description: content.description,
        tags: [],
        sections: content.sections,
        currentVersion: 1,
        sourceRepo: input.sourceRepo,
        sourcePath: input.sourcePath,
        sourceSha: input.commitSha,
      })
      .onConflictDoNothing({ target: [skills.orgId, skills.name] })
      .returning();
    if (row) {
      await writeRevision(tx, row.id, 1, "skill", content);
      return row;
    }
  }
  throw new Error(
    `could not assign a unique name for imported skill ${input.sourceRepo}/${input.sourcePath}`,
  );
}

/**
 * Upsert a skill from its GitHub source, atomically. Resolves the existing row
 * by (org, repo, path); creates it (kind "skill") with a v1 revision when
 * absent, appends a new revision + advances source_sha when the parsed content
 * differs from the current revision, and is a pure no-op when unchanged.
 */
export async function importSkillFromSource(input: {
  orgId: string;
  sourceRepo: string;
  sourcePath: string;
  commitSha: string;
  content: SkillContent;
}): Promise<ImportUpsertOutcome> {
  const { orgId, sourceRepo, sourcePath, commitSha, content } = input;
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.orgId, orgId),
          eq(skills.sourceRepo, sourceRepo),
          eq(skills.sourcePath, sourcePath),
        ),
      )
      .limit(1);

    if (existing) {
      // Security-anchored skills are OWNED by their seeder, never by imports:
      // the hosted login-as gate pins an exact canonical content hash, and an
      // import appending a repo revision bumps current_version past it - the
      // 2026-08-20 resync sweep did exactly that and broke every login until a
      // re-seed. The repo's own copy still imports under a suffixed name via
      // the create path's conflict handling.
      if (existing.name.trim().toLowerCase() === "login-as") {
        return {
          action: "protected" as const,
          skillId: existing.id,
          version: existing.currentVersion,
        };
      }
      // Name stays fixed (org-unique identity); description + sections track source.
      const nextContent: SkillContent = {
        name: existing.name,
        description: content.description,
        sections: content.sections,
      };
      const nextHash = hashSkillContent(formatSkillMarkdown(nextContent));
      const [curRev] = await tx
        .select({ hash: skillRevisions.contentHash })
        .from(skillRevisions)
        .where(
          and(
            eq(skillRevisions.skillId, existing.id),
            eq(skillRevisions.version, existing.currentVersion),
          ),
        )
        .limit(1);
      if (curRev && curRev.hash === nextHash) {
        return {
          action: "unchanged" as const,
          skillId: existing.id,
          version: existing.currentVersion,
        };
      }
      const nextVersion = existing.currentVersion + 1;
      await tx
        .update(skills)
        .set({
          description: nextContent.description,
          sections: nextContent.sections,
          currentVersion: nextVersion,
          sourceSha: commitSha,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, existing.id));
      await writeRevision(tx, existing.id, nextVersion, existing.kind, nextContent);
      return { action: "updated" as const, skillId: existing.id, version: nextVersion };
    }

    const created = await createImportedSkill(tx, {
      orgId,
      sourceRepo,
      sourcePath,
      commitSha,
      content,
    });
    return { action: "created" as const, skillId: created.id, version: 1 };
  });
}
