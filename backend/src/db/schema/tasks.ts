import {
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { projects } from "./projects";

// ---------------------------------------------------------------------------
// Tasks - a durable, org-scoped native task manager (Tier-2). A task outlives
// the run that created it: an agent mid-run can create/update tasks through the
// knowledge gateway, and they persist in Postgres afterwards (the durability win
// over an ephemeral in-sandbox / MCP task server). Tasks are grouped per project
// (`project_key` - a repo full_name like "owner/name", or a free label) and
// rendered as a Kanban board. Org-scoped: every read/write filters by org_id.
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ["todo", "in_progress", "done", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    // The project this task belongs to - a repo full_name ("owner/name") or a
    // free label. Nullable: an unfiled task has no project. Indexed with org_id
    // so the board query for one project is a single covered lookup.
    projectKey: text("project_key"),
    title: text("title").notNull(),
    body: text("body"),
    // 'todo' | 'in_progress' | 'done' | 'archived' - the Kanban column.
    status: text("status").$type<TaskStatus>().notNull().default("todo"),
    priority: integer("priority").notNull().default(0),
    // Ordering within a column. A float lets a reorder drop a card between two
    // neighbours by taking their midpoint without renumbering the whole column.
    orderKey: doublePrecision("order_key").notNull().default(0),
    // Provenance. Both nullable: a task can be created by a human (user id) or by
    // an agent mid-run (source run id); neither is required.
    createdByUserId: text("created_by_user_id"),
    sourceRunId: text("source_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_tasks_org").on(t.orgId),
    index("idx_tasks_org_project_id").on(t.orgId, t.projectId),
    index("idx_tasks_org_project").on(t.orgId, t.projectKey),
  ],
);
