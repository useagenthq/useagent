import { afterAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import "../index"; // side-effect: run committed migrations before DB assertions
import { db } from "../db/client";
import { tasks } from "../db/schema";
import { createTask, listTaskPageForOrg, listTasksForOrg, type TaskPageCursor } from "./repo";

// Paging the task list through `listTaskPageForOrg` against the real database:
// past 100 tasks, through ties the cursor has to break, and without archived
// tasks taking places on a page.

const orgIds: string[] = [];

function newOrg(label: string): string {
  const orgId = `org-tasks-${label}-${crypto.randomUUID()}`;
  orgIds.push(orgId);
  return orgId;
}

afterAll(async () => {
  for (const orgId of orgIds) await db.delete(tasks).where(eq(tasks.orgId, orgId));
});

async function readAll(
  orgId: string,
  options: { limit: number; excludeArchived?: boolean },
): Promise<{ titles: string[]; pages: number }> {
  const titles: string[] = [];
  let cursor: TaskPageCursor | null = null;
  let pages = 0;
  do {
    const page = await listTaskPageForOrg(orgId, { scope: "all" }, { ...options, cursor });
    titles.push(...page.tasks.map((task) => task.title));
    cursor = page.nextCursor;
    pages += 1;
    expect(pages).toBeLessThanOrEqual(50);
  } while (cursor);
  return { titles, pages };
}

describe("task pages", () => {
  test("the newest of 101 tasks is on the second page, and every task is read once", async () => {
    const orgId = newOrg("101");
    for (let index = 0; index < 101; index += 1) {
      await createTask({ orgId, title: `task ${index}` });
    }

    // One page of 100, in board order, stops short of the newest task.
    const first = await listTaskPageForOrg(orgId, { scope: "all" }, { limit: 100 });
    expect(first.tasks.map((task) => task.title)).toEqual(
      Array.from({ length: 100 }, (_, index) => `task ${index}`),
    );
    expect(first.nextCursor).not.toBeNull();
    const second = await listTaskPageForOrg(
      orgId,
      { scope: "all" },
      { limit: 100, cursor: first.nextCursor },
    );
    expect(second.tasks.map((task) => task.title)).toEqual(["task 100"]);
    expect(second.nextCursor).toBeNull();

    // The old one-shot read still answers its first 100 for the agent's tools.
    expect(await listTasksForOrg(orgId, { scope: "all" }, 100)).toHaveLength(100);
  });

  test("a page cut inside tasks with one position and one creation time keeps the id order", async () => {
    const orgId = newOrg("ties");
    const at = new Date(Date.now() - 60_000);
    // Twelve tasks share position 1 and the exact creation instant, so only the
    // id orders them; three more one microsecond apart share position 2.
    await db.insert(tasks).values(
      Array.from({ length: 12 }, (_, index) => ({
        orgId,
        title: `tie ${index}`,
        orderKey: 1,
        createdAt: at,
        updatedAt: at,
      })),
    );
    await db.insert(tasks).values(
      [0, 1, 2].map((index) => ({
        orgId,
        title: `micro ${index}`,
        orderKey: 2,
        createdAt: sql`${at.toISOString()}::timestamptz + ${index}::int * interval '1 microsecond'`,
        updatedAt: at,
      })),
    );
    // A fractional position from a drag between two cards.
    await db.insert(tasks).values({ orgId, title: "between", orderKey: 1.5 });

    const oneShot = (await listTaskPageForOrg(orgId, { scope: "all" }, { limit: 500 })).tasks.map(
      (task) => task.title,
    );
    expect(oneShot).toHaveLength(16);
    expect(oneShot.slice(12)).toEqual(["between", "micro 2", "micro 1", "micro 0"]);
    for (const limit of [1, 5, 7]) {
      const { titles } = await readAll(orgId, { limit });
      expect(titles).toEqual(oneShot);
    }
  });

  test("archived tasks are left out of the pages when asked", async () => {
    const orgId = newOrg("archived");
    for (let index = 0; index < 120; index += 1) {
      await createTask({
        orgId,
        title: `task ${index}`,
        status: index < 110 ? "archived" : "todo",
      });
    }

    const board = await listTaskPageForOrg(orgId, { scope: "all" }, { limit: 100, excludeArchived: true });
    expect(board.tasks.map((task) => task.title)).toEqual(
      Array.from({ length: 10 }, (_, index) => `task ${110 + index}`),
    );
    expect(board.nextCursor).toBeNull();

    const everything = await readAll(orgId, { limit: 100 });
    expect(everything.titles).toHaveLength(120);
    expect(everything.pages).toBe(2);
  });

  test("a page never reaches another workspace's tasks", async () => {
    const mine = newOrg("mine");
    const theirs = newOrg("theirs");
    await createTask({ orgId: mine, title: "mine" });
    await createTask({ orgId: theirs, title: "theirs" });
    const page = await listTaskPageForOrg(mine, { scope: "all" }, { limit: 100 });
    expect(page.tasks.map((task) => task.title)).toEqual(["mine"]);
  });
});
