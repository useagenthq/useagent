/**
 * Task board types + the PURE board-grouping logic. Kept UI-free so the
 * grouping is unit-testable without rendering (tasks-data.test.ts).
 */

export const TASK_STATUSES = ["todo", "in_progress", "done", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Sentinel filter value for "no project scope" (show every project's tasks). */
export const ALL_PROJECTS = "__all__";

/**
 * Map a `?project=` query value to the board's initial filter, so
 * `/tasks?project=owner/name` deep-links straight to that project's board and a
 * blank/missing param falls back to "All projects". Pure, so deep-link
 * preselection is unit-testable without rendering.
 */
export function initialProjectFilter(param: string | null | undefined): string {
  const trimmed = param?.trim();
  return trimmed ? trimmed : ALL_PROJECTS;
}

export interface Task {
  id: string;
  project_key: string | null;
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: number;
  order: number;
  created_at: string;
  updated_at: string;
}

/** The Kanban columns rendered on the board. `archived` is a valid status but is
 *  intentionally NOT a column - archived tasks drop off the board. */
export const BOARD_COLUMNS = [
  { status: "todo", label: "Todo" },
  { status: "in_progress", label: "In progress" },
  { status: "done", label: "Done" },
] as const satisfies readonly { status: TaskStatus; label: string }[];

export interface BoardColumn {
  status: TaskStatus;
  label: string;
  tasks: Task[];
}

/**
 * Group tasks into the three visible board columns, preserving the incoming
 * order within each column (the API already returns column-ordered rows).
 * Tasks whose status is not a board column (i.e. `archived`) are excluded.
 */
export function groupTasksByColumn(tasks: Task[]): BoardColumn[] {
  const byStatus = new Map<TaskStatus, Task[]>();
  for (const col of BOARD_COLUMNS) byStatus.set(col.status, []);
  for (const task of tasks) {
    const bucket = byStatus.get(task.status);
    if (bucket) bucket.push(task);
  }
  return BOARD_COLUMNS.map((col) => ({
    status: col.status,
    label: col.label,
    tasks: byStatus.get(col.status) ?? [],
  }));
}

/**
 * The distinct project keys present across a task list, sorted, unioned with a
 * caller-supplied repo list. Powers the project filter select so a project with
 * existing tasks is selectable even if it is no longer in the repo list.
 */
export function projectOptions(tasks: Task[], repos: string[]): string[] {
  const set = new Set<string>(repos);
  for (const task of tasks) {
    if (task.project_key) set.add(task.project_key);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
