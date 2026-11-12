import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { artifacts } from "../src/db/schema";
import { createRun } from "../src/runs/repo";
import { createOrgSession, json, type OrgSession } from "./helpers";

// GET /api/artifacts pages through the real route and database. 150 artifacts
// are seeded one second apart, except indices 45 to 54, which share one
// timestamp exactly (only the id orders them), and 98 to 105, which sit one
// microsecond apart, so page cuts land inside both groups. The expected order
// comes from Postgres directly, not from the code under test.

interface Page {
  artifacts: { id: string; run_id: string; name: string }[];
  has_more: boolean;
  next_cursor: string | null;
}

let A: OrgSession;
let B: OrgSession;
let runOne: string;
let runTwo: string;
let newestFirst: string[];
const BASE = "2026-10-01 12:00:00.000000+00";

async function run(orgId: string): Promise<string> {
  const id = crypto.randomUUID();
  await createRun({ id, prompt: "publish files", model: "test", engine: "mock", orgId, userId: null, parentRunId: null, threadId: id, repos: [], memoryScope: "org" });
  return id;
}

function createdAt(index: number) {
  if (index >= 45 && index <= 54) return sql`${BASE}::timestamptz - interval '45 seconds'`;
  if (index >= 98 && index <= 105) return sql`${BASE}::timestamptz - interval '98 seconds' - ${index - 98}::int * interval '1 microsecond'`;
  return sql`${BASE}::timestamptz - ${index}::int * interval '1 second'`;
}

async function seed(orgId: string, runId: string, index: number, name: string): Promise<void> {
  await db.insert(artifacts).values({
    orgId,
    runId,
    threadId: runId,
    sourcePath: `/sandbox/${name}`,
    name,
    contentType: "text/plain",
    sizeBytes: 1,
    sha256: "a".repeat(64),
    storageKey: `test/${runId}/${name}`,
    createdAt: createdAt(index) as unknown as Date,
  });
}

async function pages(path: string, cookies: string, start: string | null = null): Promise<Page[]> {
  const out: Page[] = [];
  let cursor: string | null = start;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const response: { status: number; body: Page } = await json<Page>(cursor ? `${path}${separator}cursor=${cursor}` : path, { cookies });
    expect(response.status).toBe(200);
    out.push(response.body);
    cursor = response.body.next_cursor;
    expect(response.body.has_more).toBe(cursor !== null);
  } while (cursor && out.length < 100);
  return out;
}

const ids = (list: Page[]) => list.flatMap((page) => page.artifacts.map((artifact) => artifact.id));

beforeAll(async () => {
  A = await createOrgSession("artifact-pages");
  B = await createOrgSession("artifact-pages-other");
  runOne = await run(A.orgId);
  runTwo = await run(A.orgId);
  for (let index = 0; index < 150; index += 1) await seed(A.orgId, index % 3 === 0 ? runTwo : runOne, index, `file-${index}.txt`);
  // Older than A's newest artifact, so A's first cursor would reach it if it leaked.
  await seed(B.orgId, await run(B.orgId), 5, "other.txt");
  const rows = await db.execute<{ id: string }>(sql`select id from artifacts where org_id = ${A.orgId} order by created_at desc, id desc`);
  newestFirst = [...rows].map((row) => row.id);
});

describe("GET /api/artifacts pages", () => {
  test("the first page is the newest 100, and the 101st newest is on the next one", async () => {
    const first = await json<Page>("/api/artifacts", { cookies: A.cookies });
    expect(first.status).toBe(200);
    expect(first.body.artifacts.map((artifact) => artifact.id)).toEqual(newestFirst.slice(0, 100));
    expect(first.body.has_more).toBe(true);
    expect(first.body.next_cursor).toBeString();

    const second = await json<Page>(`/api/artifacts?cursor=${first.body.next_cursor}`, { cookies: A.cookies });
    expect(second.body.artifacts.map((artifact) => artifact.id)).toEqual(newestFirst.slice(100));
    expect(second.body).toMatchObject({ has_more: false, next_cursor: null });
  });

  test("pages of 50 and of 7 cut inside equal and microsecond-apart timestamps without a gap or a repeat", async () => {
    const fifty = await pages("/api/artifacts?limit=50", A.cookies);
    expect(fifty.map((page) => page.artifacts.length)).toEqual([50, 50, 50]);
    expect(ids(fifty)).toEqual(newestFirst);

    const seven = await pages("/api/artifacts?limit=7", A.cookies);
    expect(seven).toHaveLength(22);
    expect(ids(seven)).toEqual(newestFirst);
  });

  test("a run's artifacts page with the same filter", async () => {
    const expected = (
      await db.execute<{ id: string }>(sql`select id from artifacts where org_id = ${A.orgId} and run_id = ${runTwo} order by created_at desc, id desc`)
    ).map((row) => row.id);
    expect(expected).toHaveLength(50);
    const byRun = await pages(`/api/artifacts?run_id=${runTwo}&limit=20`, A.cookies);
    expect(byRun.map((page) => page.artifacts.length)).toEqual([20, 20, 10]);
    expect(ids(byRun)).toEqual(expected);
    expect(byRun.flatMap((page) => page.artifacts.map((artifact) => artifact.run_id))).toEqual(Array(50).fill(runTwo));
  });

  test("an artifact published after the first page is on the newest page, not a later one", async () => {
    const first = await json<Page>("/api/artifacts?limit=50", { cookies: A.cookies });
    const fresh = await run(A.orgId);
    await seed(A.orgId, fresh, -10, "fresh.txt");
    const rest = await pages("/api/artifacts?limit=50", A.cookies, first.body.next_cursor);
    expect(ids(rest)).toEqual(newestFirst.slice(50));
    const newest = await json<Page>("/api/artifacts?limit=1", { cookies: A.cookies });
    expect(newest.body.artifacts.map((artifact) => artifact.name)).toEqual(["fresh.txt"]);
    await db.execute(sql`delete from artifacts where run_id = ${fresh}`);
  });

  test("limit is held between 1 and 100", async () => {
    expect((await json<Page>("/api/artifacts?limit=0", { cookies: A.cookies })).body.artifacts).toHaveLength(1);
    expect((await json<Page>("/api/artifacts?limit=500", { cookies: A.cookies })).body.artifacts).toHaveLength(100);
    expect((await json<Page>("/api/artifacts?limit=many", { cookies: A.cookies })).body.artifacts).toHaveLength(100);
  });

  test("a cursor that is not one answers 400", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const id = crypto.randomUUID();
    for (const cursor of [
      "",
      "not a cursor",
      "%%%",
      encode([1]),
      encode({ v: 2, created_at: "2026-10-01 12:00:00+00", id }),
      encode({ v: 1, created_at: "2026-10-01 12:00:00+00" }),
      encode({ v: 1, created_at: "2026-10-01 12:00:00+00", id, extra: 1 }),
      encode({ v: 1, created_at: "2026-10-01 12:00:00+00", id: "abc" }),
      encode({ v: 1, created_at: "yesterday", id }),
      encode({ v: 1, created_at: "2026-02-30 12:00:00+00", id }),
      encode({ v: 1, created_at: "2026-10-01 25:00:00+00", id }),
      `${encode({ v: 1, created_at: "2026-10-01 12:00:00+00", id })}=`,
    ]) {
      const refused = await json<{ error: string }>(`/api/artifacts?cursor=${encodeURIComponent(cursor)}`, { cookies: A.cookies });
      expect([cursor, refused.status, refused.body]).toEqual([cursor, 400, { error: "cursor is invalid" }]);
    }
  });

  test("a cursor carries nothing across workspaces", async () => {
    const first = await json<Page>("/api/artifacts?limit=1", { cookies: A.cookies });
    const other = await json<Page>(`/api/artifacts?cursor=${first.body.next_cursor}`, { cookies: B.cookies });
    expect(other.status).toBe(200);
    expect(other.body.artifacts.map((artifact) => artifact.name)).toEqual(["other.txt"]);
  });
});
