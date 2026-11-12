import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { createOrgSession, json } from "./helpers";

// Paging `GET /api/runs?view=summary` (the All threads list) with `cursor` and
// `next_cursor`, through the real route and database.

interface SummaryPage {
  runs: Array<{ id: string; latest_status: string }>;
  has_more: boolean;
  next_cursor: string | null;
}

const ACTIVE = new Set([29, 59, 89, 119, 149]);

/** 150 single-turn threads, newest first by index. Indices 45..54 share one
 * timestamp exactly (the page 1/2 boundary at limit 50 falls among them, so
 * only the id orders them), and 98..105 are one microsecond apart (the page 2/3
 * boundary falls among them, below the millisecond a JavaScript Date keeps).
 * Threads 10..12 have a reply, so their latest turn is not their root. */
async function seedThreads(orgId: string): Promise<string[]> {
  const base = new Date(Date.now() - 3_600_000).toISOString();
  const at = (index: number) => {
    if (index >= 45 && index <= 54) return sql`${base}::timestamptz - interval '45 seconds'`;
    if (index >= 98 && index <= 105) {
      return sql`${base}::timestamptz - interval '98 seconds'
        - ${index - 98}::int * interval '1 microsecond'`;
    }
    return sql`${base}::timestamptz - ${index}::int * interval '1 second'`;
  };
  const ids = Array.from({ length: 150 }, () => crypto.randomUUID());
  await db.insert(runs).values(
    ids.map((id, index) => ({
      id,
      orgId,
      userId: null,
      prompt: `thread ${index}`,
      model: "test-model",
      engine: "mock" as const,
      status: ACTIVE.has(index) ? ("running" as const) : ("completed" as const),
      threadId: id,
      createdAt: at(index),
      updatedAt: at(index),
    })),
  );
  await db.insert(runs).values(
    [10, 11, 12].map((index) => ({
      id: crypto.randomUUID(),
      orgId,
      userId: null,
      prompt: `reply in thread ${index}`,
      model: "test-model",
      engine: "mock" as const,
      status: "completed" as const,
      parentRunId: ids[index]!,
      threadId: ids[index]!,
      createdAt: sql`${base}::timestamptz - ${index}::int * interval '1 second' + interval '100 milliseconds'`,
      updatedAt: sql`${base}::timestamptz - ${index}::int * interval '1 second' + interval '200 milliseconds'`,
    })),
  );
  return ids;
}

async function readPages(
  query: string,
  cookies: string,
  from: string | null = null,
): Promise<SummaryPage[]> {
  const pages: SummaryPage[] = [];
  let cursor = from;
  do {
    const path = cursor ? `${query}&cursor=${encodeURIComponent(cursor)}` : query;
    const response = await json<SummaryPage>(path, { cookies });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.has_more).toBe(response.body.next_cursor !== null);
    pages.push(response.body);
    cursor = response.body.next_cursor;
    expect(pages.length).toBeLessThanOrEqual(30);
  } while (cursor);
  return pages;
}

describe("run summary pages", () => {
  test("pages through 150 threads in the one-shot order with none repeated or missing", async () => {
    const session = await createOrgSession("summary-pages");
    const ids = await seedThreads(session.orgId);

    const oneShot = await json<SummaryPage>("/api/runs?view=summary&limit=1000", {
      cookies: session.cookies,
    });
    expect(oneShot.body.runs).toHaveLength(150);
    expect(oneShot.body).toMatchObject({ has_more: false, next_cursor: null });

    const pages = await readPages("/api/runs?view=summary&limit=50", session.cookies);
    expect(pages.map((page) => page.runs.length)).toEqual([50, 50, 50]);
    expect(pages.map((page) => page.has_more)).toEqual([true, true, false]);
    expect(pages.flatMap((page) => page.runs.map((run) => run.id)))
      .toEqual(oneShot.body.runs.map((run) => run.id));
    expect(new Set(pages.flatMap((page) => page.runs.map((run) => run.id)))).toEqual(new Set(ids));
  });

  test("a page cut inside a run of identical timestamps keeps the id order", async () => {
    const session = await createOrgSession("summary-page-ties");
    await seedThreads(session.orgId);

    const pages = await readPages("/api/runs?view=summary&limit=7", session.cookies);
    const paged = pages.flatMap((page) => page.runs.map((run) => run.id));
    const oneShot = await json<SummaryPage>("/api/runs?view=summary&limit=1000", {
      cookies: session.cookies,
    });
    expect(pages).toHaveLength(22);
    expect(paged).toEqual(oneShot.body.runs.map((run) => run.id));
  });

  test("with include_active, later pages leave out the active threads page 1 carried", async () => {
    const session = await createOrgSession("summary-pages-active");
    const ids = await seedThreads(session.orgId);

    const pages = await readPages(
      "/api/runs?view=summary&limit=50&include_active=1",
      session.cookies,
    );
    const first = pages[0]!.runs.map((run) => run.id);
    expect(first.slice(50)).toEqual([59, 89, 119, 149].map((index) => ids[index]));
    expect(pages.map((page) => page.runs.length)).toEqual([54, 50, 46]);
    const paged = pages.flatMap((page) => page.runs.map((run) => run.id));
    expect(paged).toHaveLength(150);
    expect(new Set(paged)).toEqual(new Set(ids));
    for (const page of pages.slice(1)) {
      expect(page.runs.some((run) => run.latest_status === "running")).toBe(false);
    }
  });

  test("a thread that gets a new turn while paging moves to the front instead of repeating", async () => {
    const session = await createOrgSession("summary-pages-moved");
    const ids = await seedThreads(session.orgId);
    const moved = ids[120]!;

    const first = await json<SummaryPage>("/api/runs?view=summary&limit=50", {
      cookies: session.cookies,
    });
    await db.update(runs).set({ updatedAt: new Date() }).where(eq(runs.id, moved));
    const rest = await readPages(
      "/api/runs?view=summary&limit=50",
      session.cookies,
      first.body.next_cursor,
    );
    const later = rest.flatMap((page) => page.runs.map((run) => run.id));
    expect(later).toHaveLength(99);
    expect(later).not.toContain(moved);
    expect(new Set([...first.body.runs.map((run) => run.id), ...later]).size).toBe(149);

    const refreshed = await json<SummaryPage>("/api/runs?view=summary&limit=50", {
      cookies: session.cookies,
    });
    expect(refreshed.body.runs[0]!.id).toBe(moved);
  });

  test("all=1 pages through every run of every thread", async () => {
    const session = await createOrgSession("summary-pages-all");
    await seedThreads(session.orgId);

    const oneShot = await json<SummaryPage>("/api/runs?view=summary&all=1&limit=1000", {
      cookies: session.cookies,
    });
    expect(oneShot.body.runs).toHaveLength(153);
    const pages = await readPages("/api/runs?view=summary&all=1&limit=40", session.cookies);
    expect(pages.map((page) => page.runs.length)).toEqual([40, 40, 40, 33]);
    expect(pages.flatMap((page) => page.runs.map((run) => run.id)))
      .toEqual(oneShot.body.runs.map((run) => run.id));
  });

  test("rejects a cursor that is malformed or from the other view", async () => {
    const session = await createOrgSession("summary-pages-cursor");
    await seedThreads(session.orgId);
    const threads = await json<SummaryPage>("/api/runs?view=summary&limit=10", {
      cookies: session.cookies,
    });
    const threadCursor = threads.body.next_cursor!;
    const forged = Buffer.from(
      JSON.stringify({ v: 1, view: "runs", created_at: "yesterday", id: "x" }),
    ).toString("base64url");
    const impossibleDate = Buffer.from(
      JSON.stringify({ v: 1, view: "runs", created_at: "2026-02-30 10:00:00.000000+00", id: "x" }),
    ).toString("base64url");

    for (const query of [
      "/api/runs?view=summary&cursor=not%20a%20cursor",
      "/api/runs?view=summary&cursor=",
      `/api/runs?view=summary&cursor=${Buffer.from("{}").toString("base64url")}`,
      `/api/runs?view=summary&all=1&cursor=${threadCursor}`,
      `/api/runs?view=summary&all=1&cursor=${forged}`,
      `/api/runs?view=summary&all=1&cursor=${impossibleDate}`,
    ]) {
      const response = await json(query, { cookies: session.cookies });
      expect(response.status, query).toBe(400);
      expect(response.body).toEqual({ error: "cursor is invalid" });
    }
  });

  test("a cursor from another workspace still lists only the caller's threads", async () => {
    const owner = await createOrgSession("summary-pages-owner");
    const other = await createOrgSession("summary-pages-other");
    const ownerIds = await seedThreads(owner.orgId);
    const otherIds = await seedThreads(other.orgId);
    const cursor = (await json<SummaryPage>("/api/runs?view=summary&limit=10", {
      cookies: owner.cookies,
    })).body.next_cursor!;

    const response = await json<SummaryPage>(`/api/runs?view=summary&limit=200&cursor=${cursor}`, {
      cookies: other.cookies,
    });
    expect(response.status).toBe(200);
    const listed = response.body.runs.map((run) => run.id);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((id) => otherIds.includes(id))).toBe(true);
    expect(listed.some((id) => ownerIds.includes(id))).toBe(false);
  });
});
