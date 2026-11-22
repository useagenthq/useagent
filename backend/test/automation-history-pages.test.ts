import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs, scheduleFirings } from "../src/db/schema";
import type { ApiFiring, ApiSchedule } from "../src/schedules/repo";
import { createOrgSession, json } from "./helpers";

// The history routes of an automation and of a bot routine, through the real
// routes and database: firings are written straight into `schedule_firings`
// (with their runs) at chosen times, so ties and sub-millisecond gaps are exact.

interface HistoryPage {
  readonly firings: ApiFiring[];
  readonly has_more: boolean;
  readonly next_cursor: string | null;
}

const previousBots = process.env.BOTS;
beforeAll(() => {
  process.env.BOTS = "1";
});
afterAll(() => {
  if (previousBots === undefined) delete process.env.BOTS;
  else process.env.BOTS = previousBots;
});

/** Record `count` firings of a schedule, one second apart and ending at
 *  2026-03-01T12:00:00Z, each with its own completed run. Returns their ids,
 *  newest first, the order the history answers. */
async function recordFirings(orgId: string, scheduleId: string, count: number, label: string): Promise<string[]> {
  const end = Date.parse("2026-03-01T12:00:00Z");
  const rows = Array.from({ length: count }, (_, index) => ({
    runId: `${label}-${crypto.randomUUID()}`,
    firedAt: new Date(end - index * 1000),
  }));
  await db.insert(runs).values(
    rows.map((row, index) => ({
      id: row.runId,
      orgId,
      userId: "user-history-pages",
      prompt: `firing ${index}`,
      model: "mock",
      engine: "mock",
      status: "completed",
      summary: `summary ${index}`,
      threadId: row.runId,
    })),
  );
  const inserted = await db
    .insert(scheduleFirings)
    .values(rows.map((row) => ({ scheduleId, runId: row.runId, firedAt: row.firedAt, trigger: "cron" as const, status: "completed" })))
    .returning({ id: scheduleFirings.id, firedAt: scheduleFirings.firedAt });
  return inserted.sort((a, b) => b.firedAt.getTime() - a.firedAt.getTime()).map((row) => row.id);
}

/** Every page of a history, `limit` at a time, following `next_cursor`. */
async function walk(path: string, cookies: string, limit: number): Promise<{ pages: HistoryPage[]; ids: string[] }> {
  const pages: HistoryPage[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    const res = await json<HistoryPage>(`${path}?${query}`, { cookies });
    expect(res.status).toBe(200);
    pages.push(res.body);
    cursor = res.body.next_cursor;
    expect(res.body.has_more).toBe(cursor !== null);
  } while (cursor && pages.length < 100);
  return { pages, ids: pages.flatMap((page) => page.firings.map((firing) => firing.id)) };
}

async function createAutomation(cookies: string): Promise<ApiSchedule> {
  const created = await json<ApiSchedule>("/api/automations", {
    method: "POST",
    cookies,
    body: { name: "Every minute", cron: "* * * * *", prompt: "check the queue", engine: "mock" },
  });
  expect(created.status).toBe(201);
  return created.body;
}

describe("automation history pages", () => {
  test("answers the newest 50 by default, and every firing exactly once across the pages", async () => {
    const { cookies, orgId } = await createOrgSession("history-pages");
    const automation = await createAutomation(cookies);
    const expected = await recordFirings(orgId, automation.id, 120, "page");
    const path = `/api/automations/${automation.id}/history`;

    const first = await json<HistoryPage>(path, { cookies });
    expect(first.status).toBe(200);
    expect(first.body.firings.map((firing) => firing.id)).toEqual(expected.slice(0, 50));
    expect(first.body.has_more).toBe(true);
    expect(typeof first.body.next_cursor).toBe("string");
    // A firing keeps its shape, joined run included.
    expect(first.body.firings[0]).toMatchObject({
      schedule_id: automation.id,
      fired_at: "2026-03-01T12:00:00.000Z",
      trigger: "cron",
      run_status: "completed",
      run_summary: "summary 0",
    });

    const { pages, ids } = await walk(path, cookies, 50);
    expect(pages.map((page) => page.firings.length)).toEqual([50, 50, 20]);
    expect(ids).toEqual(expected);
    expect(pages.at(-1)).toMatchObject({ has_more: false, next_cursor: null });
  });

  test("a page boundary between firings of the same instant, or within one millisecond, neither repeats nor skips one", async () => {
    const { cookies, orgId } = await createOrgSession("history-ties");
    const automation = await createAutomation(cookies);
    const ids = await recordFirings(orgId, automation.id, 7, "tie");
    // Four firings share one microsecond; two more sit 1 and 2 microseconds
    // after it, inside the same millisecond a JavaScript Date would round to.
    const at = (value: string) => sql`${value}::timestamptz`;
    await db.update(scheduleFirings).set({ firedAt: at("2026-03-01 12:00:00.000500+00") }).where(inArray(scheduleFirings.id, ids.slice(0, 4)));
    await db.update(scheduleFirings).set({ firedAt: at("2026-03-01 12:00:00.000501+00") }).where(eq(scheduleFirings.id, ids[4] ?? ""));
    await db.update(scheduleFirings).set({ firedAt: at("2026-03-01 12:00:00.000502+00") }).where(eq(scheduleFirings.id, ids[5] ?? ""));
    const all = await walk(`/api/automations/${automation.id}/history`, cookies, 200);
    expect(all.pages).toHaveLength(1);
    const order = all.ids;
    expect(new Set(order).size).toBe(7);

    for (const limit of [1, 2, 3]) {
      const paged = await walk(`/api/automations/${automation.id}/history`, cookies, limit);
      expect(paged.ids).toEqual(order);
    }
  });

  test("holds limit to 1 to 200 and refuses a cursor it did not hand out", async () => {
    const { cookies, orgId } = await createOrgSession("history-limits");
    const automation = await createAutomation(cookies);
    await recordFirings(orgId, automation.id, 205, "limit");
    const path = `/api/automations/${automation.id}/history`;
    const size = async (query: string) => (await json<HistoryPage>(`${path}?${query}`, { cookies })).body.firings.length;
    expect(await size("limit=0")).toBe(1);
    expect(await size("limit=-5")).toBe(1);
    expect(await size("limit=7")).toBe(7);
    expect(await size("limit=1000")).toBe(200);
    expect(await size("limit=many")).toBe(50);

    const forged = Buffer.from(JSON.stringify({ v: 1, created_at: "not a time", id: crypto.randomUUID() })).toString("base64url");
    for (const cursor of ["", "not-base64!", forged]) {
      const res = await json<{ error: string }>(`${path}?cursor=${encodeURIComponent(cursor)}`, { cookies });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "cursor is invalid" });
    }
  });

  test("another workspace's automation answers 404, cursor or not", async () => {
    const owner = await createOrgSession("history-owner");
    const stranger = await createOrgSession("history-stranger");
    const automation = await createAutomation(owner.cookies);
    await recordFirings(owner.orgId, automation.id, 3, "owner");
    const first = await json<HistoryPage>(`/api/automations/${automation.id}/history?limit=1`, { cookies: owner.cookies });
    const cursor = first.body.next_cursor ?? "";
    expect(cursor).not.toBe("");
    for (const query of ["", `?cursor=${cursor}`]) {
      const res = await json(`/api/automations/${automation.id}/history${query}`, { cookies: stranger.cookies });
      expect(res.status).toBe(404);
    }
  });
});

describe("bot routine history pages", () => {
  test("pages a routine's firings the same way", async () => {
    const { cookies, orgId } = await createOrgSession("routine-history-pages");
    const bot = await json<{ bot: { id: string } }>("/api/bots", {
      method: "POST",
      cookies,
      body: { name: "Pager", title: "Queue watcher", rules: "Watch the queue.", engine: "mock" },
    });
    expect(bot.status).toBe(201);
    const routine = await json<{ routine: { id: string } }>(`/api/bots/${bot.body.bot.id}/routines`, {
      method: "POST",
      cookies,
      body: { name: "Tick", cron: "* * * * *", prompt: "Check the queue." },
    });
    expect(routine.status).toBe(201);
    const expected = await recordFirings(orgId, routine.body.routine.id, 60, "routine");
    const path = `/api/bots/${bot.body.bot.id}/routines/${routine.body.routine.id}/history`;

    const first = await json<HistoryPage>(path, { cookies });
    expect(first.body.firings).toHaveLength(50);
    expect(first.body.has_more).toBe(true);

    const { pages, ids } = await walk(path, cookies, 25);
    expect(pages.map((page) => page.firings.length)).toEqual([25, 25, 10]);
    expect(ids).toEqual(expected);

    const bad = await json<{ error: string }>(`${path}?cursor=nope`, { cookies });
    expect(bad.status).toBe(400);
  });
});
