import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export interface SkillSections {
  overview: string[];
  procedure: string[];
  verify: string[];
}

// A skill row is one of two user-facing kinds over the SAME substrate (mem_op:
// "treat playbooks as versioned skills/content, not a second executor"). A
// "playbook" is just a skill surfaced as a structured Overview/Procedure/Verify
// procedure. Immutable per row — an edit mints a new content version, never a
// kind change.
export const SKILL_KINDS = ["skill", "playbook"] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

// ---------------------------------------------------------------------------
// Skills — org-scoped reusable playbooks.
// ---------------------------------------------------------------------------

export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    // "skill" (default) or "playbook" — the SAME substrate surfaced under two
    // product labels (mem_op: not a second executor). Immutable per row.
    kind: text("kind").$type<SkillKind>().notNull().default("skill"),
    description: text("description").notNull().default(""),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // The skill's LATEST instruction content. `skill_revisions` holds the
    // immutable history; this is a convenience mirror of the current version's
    // content. An edit bumps `currentVersion` and appends a new revision.
    sections: jsonb("sections").$type<SkillSections>().notNull(),
    currentVersion: integer("current_version").notNull().default(1),
    // Provenance for a skill imported from a GitHub repo (multi-repo). Null for
    // hand-authored skills. (org_id, source_repo, source_path) is the import
    // identity — a re-import that finds changed content appends a revision and
    // advances `source_sha` to the commit the new content was read at; unchanged
    // content is a no-op. See src/github/discovery.ts + src/skills/import.ts.
    sourceRepo: text("source_repo"),
    sourcePath: text("source_path"),
    sourceSha: text("source_sha"),
    usageCount: integer("usage_count").notNull().default(0),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("uq_skills_org_name").on(t.orgId, t.name)],
);

// Immutable skill revisions — every version of a skill's instruction content,
// snapshotted at create/edit time. A run pins one revision (skill_id + version);
// because revisions are never mutated, a later edit (which appends a NEW row)
// cannot alter a historical run's loaded content. `content_hash` is the sha256 of
// the formatted SKILL.md, the addressable identity emitted in `skill.loaded`.
export const skillRevisions = pgTable(
  "skill_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // Denormalized from `skills.kind` so the worker materializes + attributes a
    // pinned revision (skill.loaded marker) from a single-table read. Immutable,
    // so no update anomaly vs the parent row.
    kind: text("kind").$type<SkillKind>().notNull().default("skill"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    sections: jsonb("sections").$type<SkillSections>().notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("uq_skill_rev").on(t.skillId, t.version)],
);
