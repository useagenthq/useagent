import { describe, expect, test } from "bun:test";
import { ready, sql } from "../src/knowledge/store";
import { createOrgSession, json } from "./helpers";

// Paging `GET /api/knowledge` (the Knowledge page) with `cursor` and
// `next_cursor`, through the real route and database. The expected order comes
// from Postgres directly, never from the code under test.

interface RecordsPage {
  records: Array<{ id: string; title: string; pinned: boolean }>;
  has_more: boolean;
  next_cursor: string | null;
}

/** `count` records in `orgId`, one second apart and newest last by index,
 *  except that indices in `sameInstant` share one timestamp exactly and those in
 *  `microApart` sit one microsecond apart. `pinned` indices are pinned. */
async function seedRecords(
  orgId: string,
  count: number,
  options: {
    pinned?: ReadonlySet<number>;
    sameInstant?: readonly [number, number];
    microApart?: readonly [number, number];
    title?: (index: number) => string;
  } = {},
): Promise<void> {
  await ready();
  const base = new Date(Date.now() - 3_600_000).toISOString();
  for (let index = 0; index < count; index += 1) {
    const [sameFrom, sameTo] = options.sameInstant ?? [-1, -1];
    const [microFrom, microTo] = options.microApart ?? [-1, -1];
    const at =
      index >= sameFrom && index <= sameTo
        ? sql`${base}::timestamptz + ${sameFrom}::int * interval '1 second'`
        : index >= microFrom && index <= microTo
          ? sql`${base}::timestamptz + ${microFrom}::int * interval '1 second'
              + ${index - microFrom}::int * interval '1 microsecond'`
          : sql`${base}::timestamptz + ${index}::int * interval '1 second'`;
    await sql`
      INSERT INTO knowledge_records (
        org_id, kind, title, body, external_id, connector_instance_id,
        content_hash, distillation_key, pinned, created_at, updated_at
      ) VALUES (
        ${orgId}, 'note', ${options.title?.(index) ?? `Record ${index}`}, 'Body text.',
        ${`record-${index}`}, 'test:pages', ${`hash-${index}`}, ${`key-${index}`},
        ${options.pinned?.has(index) ?? false}, ${at}, ${at}
      )
    `;
  }
}

async function expectedOrder(orgId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM knowledge_records WHERE org_id = ${orgId}
    ORDER BY pinned DESC, created_at DESC, id DESC
  `;
  return rows.map((row) => row.id);
}

async function readPages(path: string, cookies: string): Promise<RecordsPage[]> {
  const pages: RecordsPage[] = [];
  let cursor: string | null = null;
  do {
    const url: string = cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path;
    const response = await json<RecordsPage>(url, { cookies });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.has_more).toBe(response.body.next_cursor !== null);
    pages.push(response.body);
    cursor = response.body.next_cursor;
    expect(pages.length).toBeLessThanOrEqual(60);
  } while (cursor);
  return pages;
}

describe("knowledge record pages", () => {
  test("record 201 is on the second page, pinned records first, none repeated or missing", async () => {
    const session = await createOrgSession("knowledge-pages");
    await seedRecords(session.orgId, 230, { pinned: new Set([3, 150]) });
    const expected = await expectedOrder(session.orgId);

    const first = await json<RecordsPage>("/api/knowledge", { cookies: session.cookies });
    expect(first.body.records).toHaveLength(200);
    expect(first.body.records.slice(0, 2).map((record) => record.title)).toEqual([
      "Record 150",
      "Record 3",
    ]);
    expect(first.body.has_more).toBe(true);
    // The oldest unpinned records, past the newest 200, were out of reach before.
    expect(first.body.records.map((record) => record.title)).not.toContain("Record 0");

    const pages = await readPages("/api/knowledge?limit=200", session.cookies);
    expect(pages.map((page) => page.records.length)).toEqual([200, 30]);
    const titles = pages.flatMap((page) => page.records.map((record) => record.title));
    expect(titles[200]).toBe("Record 30");
    expect(titles.at(-1)).toBe("Record 0");
    expect(pages.flatMap((page) => page.records.map((record) => record.id))).toEqual(expected);
  });

  test("a page cut inside equal and microsecond-apart creation times keeps the id order", async () => {
    const session = await createOrgSession("knowledge-page-ties");
    await seedRecords(session.orgId, 40, {
      pinned: new Set([5, 6, 7]),
      sameInstant: [10, 19],
      microApart: [25, 32],
    });
    const expected = await expectedOrder(session.orgId);
    for (const limit of [1, 4, 7]) {
      const pages = await readPages(`/api/knowledge?limit=${limit}`, session.cookies);
      expect(pages.flatMap((page) => page.records.map((record) => record.id))).toEqual(expected);
    }
  });

  test("a keyword filter pages too", async () => {
    const session = await createOrgSession("knowledge-page-filter");
    await seedRecords(session.orgId, 30, {
      title: (index) => (index % 3 === 0 ? `Heron migration ${index}` : `Record ${index}`),
    });
    const pages = await readPages("/api/knowledge?q=heron&limit=4", session.cookies);
    expect(pages.map((page) => page.records.length)).toEqual([4, 4, 2]);
    expect(pages.flatMap((page) => page.records.map((record) => record.title))).toEqual(
      [27, 24, 21, 18, 15, 12, 9, 6, 3, 0].map((index) => `Heron migration ${index}`),
    );
  });

  test("limit is held between 1 and 500, and a non-number gives 200", async () => {
    const session = await createOrgSession("knowledge-page-limit");
    await seedRecords(session.orgId, 3);
    const one = await json<RecordsPage>("/api/knowledge?limit=0", { cookies: session.cookies });
    expect(one.body.records).toHaveLength(1);
    expect(one.body.has_more).toBe(true);
    const all = await json<RecordsPage>("/api/knowledge?limit=abc", { cookies: session.cookies });
    expect(all.body).toMatchObject({ has_more: false, next_cursor: null });
    expect(all.body.records).toHaveLength(3);
  });

  test("a malformed cursor answers 400", async () => {
    const session = await createOrgSession("knowledge-page-cursor");
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const cursor of [
      "",
      "not a cursor",
      encode({ pinned: false }),
      encode([false, "1793865600123456"]),
      encode(["false", "1793865600123456", crypto.randomUUID()]),
      encode([false, 1793865600123456, crypto.randomUUID()]),
      encode([false, "-1", crypto.randomUUID()]),
      encode([false, "999999999999999999", crypto.randomUUID()]),
      encode([false, "1793865600123456", "not-a-uuid"]),
    ]) {
      const response = await json<{ error: string }>(
        `/api/knowledge?cursor=${encodeURIComponent(cursor)}`,
        { cookies: session.cookies },
      );
      expect(response.status, cursor).toBe(400);
      expect(response.body.error).toBe("cursor is invalid");
    }
  });

  test("a cursor carries nothing across workspaces", async () => {
    const owner = await createOrgSession("knowledge-page-owner");
    const other = await createOrgSession("knowledge-page-other");
    await seedRecords(owner.orgId, 3);
    await seedRecords(other.orgId, 2);
    const first = await json<RecordsPage>("/api/knowledge?limit=1", { cookies: owner.cookies });
    const crossed = await json<RecordsPage>(
      `/api/knowledge?limit=10&cursor=${encodeURIComponent(first.body.next_cursor ?? "")}`,
      { cookies: other.cookies },
    );
    expect(crossed.status).toBe(200);
    const otherIds = new Set(await expectedOrder(other.orgId));
    expect(crossed.body.records.every((record) => otherIds.has(record.id))).toBe(true);
  });
});
