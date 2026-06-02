import { describe, expect, test } from "bun:test";
import {
  ALL_PROJECTS,
  BOARD_COLUMNS,
  groupTasksByColumn,
  initialProjectFilter,
  projectOptions,
  type Task,
  type TaskStatus,
} from "./tasks-data";

function task(id: string, status: TaskStatus, over: Partial<Task> = {}): Task {
  return {
    id,
    project_key: null,
    title: `task ${id}`,
    body: null,
    status,
    priority: 0,
    order: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("groupTasksByColumn", () => {
  test("always returns the three board columns in order", () => {
    const cols = groupTasksByColumn([]);
    expect(cols.map((c) => c.status)).toEqual(["todo", "in_progress", "done"]);
    expect(cols.map((c) => c.label)).toEqual(BOARD_COLUMNS.map((c) => c.label));
    expect(cols.every((c) => c.tasks.length === 0)).toBe(true);
  });

  test("buckets tasks into their status column and preserves input order", () => {
    const cols = groupTasksByColumn([
      task("a", "todo"),
      task("b", "done"),
      task("c", "todo"),
      task("d", "in_progress"),
    ]);
    const byStatus = Object.fromEntries(cols.map((c) => [c.status, c.tasks.map((t) => t.id)]));
    expect(byStatus.todo).toEqual(["a", "c"]);
    expect(byStatus.in_progress).toEqual(["d"]);
    expect(byStatus.done).toEqual(["b"]);
  });

  test("excludes archived tasks from every column", () => {
    const cols = groupTasksByColumn([task("a", "archived"), task("b", "todo")]);
    const ids = cols.flatMap((c) => c.tasks.map((t) => t.id));
    expect(ids).toEqual(["b"]);
  });
});

describe("projectOptions", () => {
  test("unions repo list with distinct task project keys, sorted", () => {
    const opts = projectOptions(
      [task("a", "todo", { project_key: "zeta/app" }), task("b", "done", { project_key: null })],
      ["acme/web", "acme/web"],
    );
    expect(opts).toEqual(["acme/web", "zeta/app"]);
  });
});

describe("initialProjectFilter", () => {
  test("a `?project=` value preselects that project (deep-link)", () => {
    expect(initialProjectFilter("acme/api")).toBe("acme/api");
  });

  test("a missing or blank param falls back to All projects", () => {
    expect(initialProjectFilter(undefined)).toBe(ALL_PROJECTS);
    expect(initialProjectFilter(null)).toBe(ALL_PROJECTS);
    expect(initialProjectFilter("")).toBe(ALL_PROJECTS);
    expect(initialProjectFilter("   ")).toBe(ALL_PROJECTS);
  });
});
