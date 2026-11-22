import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs, scheduleFirings } from "../src/db/schema";
import { createOrgSession, json } from "./helpers";

// Paging `GET /api/automations/:id/history` (and the bot routine history, which
// reads the same firing log) with `limit` and `before`/`next_cursor`, through
// the real route and database. The expected order comes from a one-shot read
// at the maximum limit.

interface HistoryPage {
  firings: Array<{ id: string; run_id: string; fired_at: string }>;
  has_more: boolean;
  next_cursor: string | null;
}

const previousBots = process.env.BOTS;
beforeAll(() => {
  process.env.BOTS = "1";
});
afterAll(() => {
  if (previousBots === undefined) delete process.env.BOTS;
  else process.env.BOTS = previousBots;
});

/** 120 firings for `scheduleId`, newest first by index. Indices 48..57 share
 *  one timestamp exactly (a limit-50 page cut lands inside them, so only the id
 *  orders the firings on either side of it). */
async function seedFirings(orgId: string, scheduleId: string): Promise<void> {
  const base = new Date(Date.now() - 3_600_000).toISOString();
  const at = (index: number) =>
    index >= 48 && index <= 57
      ? sql`${base}::timestamptz - interval '55 seconds'`
      : sql`${base}::timestamptz - ${index}::int * interval '1 second'`;
  const runIds = Array.from({ length: 120 }, () => crypto.randomUUID());
  await db.insert(runs).values(
    runIds.map((id, index) => ({
      id,
      orgId,
      userId: null,
      prompt: `firing run ${index}`,
      model: "test-model",
      engine: "mock" as const,
      status: "completed" as const,
      threadId: id,
      createdAt: at(index),
      updatedAt: at(index),
    })),
  );
  await db.insert(scheduleFirings).values(
    runIds.map((runId, index) => ({
      scheduleId,
      runId,
      idempotencyKey: `firing-pages:${scheduleId}:${index}`,
      firedAt: at(index),
      trigger: "cron" as const,
      status: "completed",
    })),
  );
}

async function createAutomation(cookies: string): Promise<string> {
  const res = await json<{ id: string }>("/api/automations", {
    method: "POST",
    body: { name: "Paged history", cron: "* * * * *", prompt: "hi", engine: "mock" },
    cookies,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** Walk a history route with `before` until `next_cursor` is null. */
async function readPages(
  path: string,
  cookies: string,
  from: string | null = null,
): Promise<HistoryPage[]> {
  const pages: HistoryPage[] = [];
  let before = from;
  do {
    const response = await json<HistoryPage>(
      before ? `${path}&before=${encodeURIComponent(before)}` : path,
      { cookies },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.has_more).toBe(response.body.next_cursor !== null);
    pages.push(response.body);
    before = response.body.next_cursor;
    expect(pages.length).toBeLessThanOrEqual(40);
  } while (before);
  return pages;
}

describe("firing history pages", () => {
  test("the automation history pages in the one-shot order with none repeated or missing", async () => {
    const s = await createOrgSession("firing-pages");
    const scheduleId = await createAutomation(s.cookies);
    await seedFirings(s.orgId, scheduleId);

    const oneShot = await json<HistoryPage>(`/api/automations/${scheduleId}/history?limit=200`, {
      cookies: s.cookies,
    });
    expect(oneShot.body.firings).toHaveLength(120);
    expect(oneShot.body).toMatchObject({ has_more: false, next_cursor: null });

    const pages = await readPages(`/api/automations/${scheduleId}/history?limit=50`, s.cookies);
    expect(pages.map((page) => page.firings.length)).toEqual([50, 50, 20]);
    expect(pages.map((page) => page.has_more)).toEqual([true, true, false]);
    const paged = pages.flatMap((page) => page.firings.map((firing) => firing.id));
    expect(paged).toEqual(oneShot.body.firings.map((firing) => firing.id));
    expect(new Set(paged).size).toBe(120);
  });

  test("the default page holds 50 and a small limit walks the same order", async () => {
    const s = await createOrgSession("firing-default-page");
    const scheduleId = await createAutomation(s.cookies);
    await seedFirings(s.orgId, scheduleId);

    const firstPage = await json<HistoryPage>(`/api/automations/${scheduleId}/history`, {
      cookies: s.cookies,
    });
    expect(firstPage.body.firings).toHaveLength(50);
    expect(firstPage.body.has_more).toBe(true);
    expect(firstPage.body.next_cursor).not.toBeNull();

    const pages = await readPages(`/api/automations/${scheduleId}/history?limit=7`, s.cookies);
    const paged = pages.flatMap((page) => page.firings.map((firing) => firing.id));
    const oneShot = await json<HistoryPage>(`/api/automations/${scheduleId}/history?limit=200`, {
      cookies: s.cookies,
    });
    expect(paged).toEqual(oneShot.body.firings.map((firing) => firing.id));
  });

  test("`before` returns only the firings older than the page it came from", async () => {
    const s = await createOrgSession("firing-before");
    const scheduleId = await createAutomation(s.cookies);
    await seedFirings(s.orgId, scheduleId);

    const first = await json<HistoryPage>(`/api/automations/${scheduleId}/history?limit=10`, {
      cookies: s.cookies,
    });
    const rest = await readPages(
      `/api/automations/${scheduleId}/history?limit=200`,
      s.cookies,
      first.body.next_cursor,
    );
    const older = rest.flatMap((page) => page.firings.map((firing) => firing.id));
    expect(older).toHaveLength(110);
    const boundary = first.body.firings.at(-1)!;
    expect(older).not.toContain(boundary.id);
    expect(first.body.firings.some((firing) => older.includes(firing.id))).toBe(false);
    expect(rest[0]!.firings.every((firing) => firing.fired_at <= boundary.fired_at)).toBe(true);
  });

  test("an invalid before cursor is a 400 on both history routes", async () => {
    const s = await createOrgSession("firing-bad-cursor");
    const scheduleId = await createAutomation(s.cookies);
    const forged = Buffer.from(
      JSON.stringify({ v: 1, fired_at: "yesterday", id: "x" }),
    ).toString("base64url");
    const impossible = Buffer.from(
      JSON.stringify({ v: 1, fired_at: "2026-02-30 10:00:00.000000+00", id: crypto.randomUUID() }),
    ).toString("base64url");
    for (const query of [
      `/api/automations/${scheduleId}/history?before=not%20a%20cursor`,
      `/api/automations/${scheduleId}/history?before=`,
      `/api/automations/${scheduleId}/history?before=${Buffer.from("{}").toString("base64url")}`,
      `/api/automations/${scheduleId}/history?before=${forged}`,
      `/api/automations/${scheduleId}/history?before=${impossible}`,
    ]) {
      const response = await json(query, { cookies: s.cookies });
      expect(response.status, query).toBe(400);
      expect(response.body).toEqual({ error: "cursor is invalid" });
    }
  });

  test("a bot routine's history pages the same way", async () => {
    const s = await createOrgSession("routine-pages");
    const bot = await json<{ bot: { id: string } }>("/api/bots", {
      method: "POST",
      cookies: s.cookies,
      body: { name: "Pager", title: "Keeps count", rules: "Count honestly.", engine: "mock" },
    });
    expect(bot.status).toBe(201);
    const created = await json<{ routine: { id: string } }>(
      `/api/bots/${bot.body.bot.id}/routines`,
      {
        method: "POST",
        cookies: s.cookies,
        body: { name: "Every minute", cron: "* * * * *", prompt: "Check the queue." },
      },
    );
    expect(created.status).toBe(201);
    const routineId = created.body.routine.id;
    try {
      await seedFirings(s.orgId, routineId);

      const pages = await readPages(
        `/api/bots/${bot.body.bot.id}/routines/${routineId}/history?limit=50`,
        s.cookies,
      );
      expect(pages.map((page) => page.firings.length)).toEqual([50, 50, 20]);
      expect(pages.map((page) => page.has_more)).toEqual([true, true, false]);
      const oneShot = await json<HistoryPage>(
        `/api/bots/${bot.body.bot.id}/routines/${routineId}/history?limit=200`,
        { cookies: s.cookies },
      );
      expect(pages.flatMap((page) => page.firings.map((firing) => firing.id)))
        .toEqual(oneShot.body.firings.map((firing) => firing.id));
    } finally {
      // Routines are created enabled; pause it so the tick never fires it mid-suite.
      await json(`/api/bots/${bot.body.bot.id}/routines/${routineId}`, {
        method: "PATCH",
        cookies: s.cookies,
        body: { enabled: false },
      });
    }
  });
});
