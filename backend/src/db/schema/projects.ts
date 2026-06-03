import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Durable project identity. A project may be backed by one GitHub repository,
// or be a standalone workspace with no repository. Runs and tasks reference
// this row; repo strings remain compatibility metadata, not identity.
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    repoFullName: text("repo_full_name"),
    archived: boolean("archived").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_projects_org_key").on(t.orgId, t.key),
    uniqueIndex("uq_projects_org_repo").on(t.orgId, t.repoFullName),
    index("idx_projects_org_active_order").on(t.orgId, t.archived, t.sortOrder, t.id),
  ],
);
