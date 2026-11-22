import { describe, expect, test } from "bun:test";
import { ready, sql } from "../src/knowledge/store";
import { createOrgSession, json } from "./helpers";

// Paging the wiki document list (`GET /api/knowledge/documents`, the Wiki
// page) and a document's revisions, through the real routes and database. The
// expected order comes from Postgres directly, never from the code under test.

interface DocumentsPage {
  documents: Array<Record<string, unknown> & { id: string; title: string; excerpt: string }>;
  has_more: boolean;
  next_cursor: string | null;
}

interface RevisionsPage {
  revisions: Array<{ id: string; content: string }>;
  has_more: boolean;
  next_cursor: string | null;
}

/** `count` documents in `orgId`, updated one second apart and newest last by
 *  index, each with one revision holding `content(index)`. Indices in
 *  `sameInstant` share one update time exactly and those in `microApart` sit
 *  one microsecond apart. Drafts are listed in `drafts`; the rest are published. */
async function seedDocuments(
  orgId: string,
  count: number,
  options: {
    drafts?: ReadonlySet<number>;
    sameInstant?: readonly [number, number];
    microApart?: readonly [number, number];
    content?: (index: number) => string;
  } = {},
): Promise<string[]> {
  await ready();
  const base = new Date(Date.now() - 3_600_000).toISOString();
  const ids: string[] = [];
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
    const draft = options.drafts?.has(index) ?? false;
    const [doc] = await sql<{ id: string }[]>`
      INSERT INTO knowledge_documents (org_id, title, status, created_at, updated_at)
      VALUES (${orgId}, ${`Page ${index}`}, ${draft ? "draft" : "published"}, ${at}, ${at})
      RETURNING id
    `;
    const [rev] = await sql<{ id: string }[]>`
      INSERT INTO knowledge_revisions (document_id, org_id, content, content_hash, created_at)
      VALUES (${doc!.id}, ${orgId}, ${options.content?.(index) ?? `# Page ${index}\n\nAbout page ${index}.`},
              ${`hash-${index}`}, ${at})
      RETURNING id
    `;
    if (!draft) {
      await sql`UPDATE knowledge_documents SET published_revision_id = ${rev!.id} WHERE id = ${doc!.id}`;
    }
    ids.push(doc!.id);
  }
  return ids;
}

async function expectedOrder(orgId: string, status: string | null = "published"): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM knowledge_documents
    WHERE org_id = ${orgId} ${status ? sql`AND status = ${status}` : sql``}
    ORDER BY updated_at DESC, created_at DESC, id DESC
  `;
  return rows.map((row) => row.id);
}

async function readPages<T extends { has_more: boolean; next_cursor: string | null }>(
  path: string,
  cookies: string,
): Promise<T[]> {
  const pages: T[] = [];
  let cursor: string | null = null;
  const join = path.includes("?") ? "&" : "?";
  do {
    const url: string = cursor ? `${path}${join}cursor=${encodeURIComponent(cursor)}` : path;
    const response = await json<T>(url, { cookies });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.has_more).toBe(response.body.next_cursor !== null);
    pages.push(response.body);
    cursor = response.body.next_cursor;
    expect(pages.length).toBeLessThanOrEqual(60);
  } while (cursor);
  return pages;
}

describe("wiki document pages", () => {
  test("the list answers 50 excerpts a page, and a document past the first page opens in full", async () => {
    const session = await createOrgSession("wiki-pages");
    await seedDocuments(session.orgId, 130, { drafts: new Set([7, 120]) });
    const expected = await expectedOrder(session.orgId);
    expect(expected).toHaveLength(128);

    const first = await json<DocumentsPage>("/api/knowledge/documents", { cookies: session.cookies });
    expect(first.status).toBe(200);
    expect(first.body.documents).toHaveLength(50);
    expect(first.body.has_more).toBe(true);
    expect(first.body.documents[0]).toMatchObject({ title: "Page 129", excerpt: "About page 129." });
    for (const document of first.body.documents) expect(document).not.toHaveProperty("content");

    const pages = await readPages<DocumentsPage>("/api/knowledge/documents", session.cookies);
    expect(pages.map((page) => page.documents.length)).toEqual([50, 50, 28]);
    const listed = pages.flatMap((page) => page.documents);
    expect(listed.map((document) => document.id)).toEqual(expected);
    expect(listed.map((document) => document.title)).not.toContain("Page 7");

    // Page 0 is on the last page; reading it directly gives its whole content.
    const oldest = listed.at(-1)!;
    expect(oldest.title).toBe("Page 0");
    const one = await json<any>(`/api/knowledge/documents/${oldest.id}`, { cookies: session.cookies });
    expect(one.status).toBe(200);
    expect(one.body.document).toMatchObject({ status: "published", content: "# Page 0\n\nAbout page 0." });
  });

  test("a page cut inside equal and microsecond-apart update times keeps the id order", async () => {
    const session = await createOrgSession("wiki-page-ties");
    await seedDocuments(session.orgId, 30, { sameInstant: [5, 14], microApart: [18, 25] });
    const expected = await expectedOrder(session.orgId);
    for (const limit of [1, 4, 7]) {
      const pages = await readPages<DocumentsPage>(
        `/api/knowledge/documents?limit=${limit}`,
        session.cookies,
      );
      expect(pages.flatMap((page) => page.documents.map((document) => document.id))).toEqual(expected);
    }
  });

  test("a status filter pages too", async () => {
    const session = await createOrgSession("wiki-page-status");
    await seedDocuments(session.orgId, 12, { drafts: new Set([1, 4, 5, 9, 11]) });
    const drafts = await readPages<DocumentsPage>(
      "/api/knowledge/documents?status=draft&limit=2",
      session.cookies,
    );
    expect(drafts.map((page) => page.documents.length)).toEqual([2, 2, 1]);
    expect(drafts.flatMap((page) => page.documents.map((document) => document.title))).toEqual(
      [11, 9, 5, 4, 1].map((index) => `Page ${index}`),
    );
    const all = await readPages<DocumentsPage>("/api/knowledge/documents?status=all&limit=5", session.cookies);
    expect(all.flatMap((page) => page.documents.map((document) => document.id))).toEqual(
      await expectedOrder(session.orgId, null),
    );
  });

  test("the excerpt is the first line of prose, past the source files and the title", async () => {
    const session = await createOrgSession("wiki-page-excerpt");
    const sources = (links: number) =>
      [
        "<details>",
        "<summary>Relevant source files</summary>",
        "",
        "The following files were used as context for generating this wiki page:",
        "",
        ...Array.from(
          { length: links },
          (_, index) => `- [src/file-${index}.ts](https://github.com/acme/demo/blob/main/src/file-${index}.ts)`,
        ),
        "</details>",
      ].join("\n");
    const contents = [
      `${sources(5)}\n\n# Page 0\n\nThe run gate keeps sessions bounded.\n\nMore detail.`,
      `# Page 1\n\n${"word ".repeat(200)}`,
      // A disclosure longer than the start the list reads leaves no preview.
      `${sources(200)}\n\n# Page 2\n\nNever reached.`,
      "# Page 3",
    ];
    await seedDocuments(session.orgId, contents.length, { content: (index) => contents[index]! });

    const list = await json<DocumentsPage>("/api/knowledge/documents", { cookies: session.cookies });
    const excerpt = (title: string) =>
      list.body.documents.find((document) => document.title === title)?.excerpt;
    expect(excerpt("Page 0")).toBe("The run gate keeps sessions bounded.");
    expect(excerpt("Page 1")).toHaveLength(280);
    expect(excerpt("Page 1")!.endsWith("word…")).toBe(true);
    expect(excerpt("Page 2")).toBe("");
    expect(excerpt("Page 3")).toBe("");
  });

  test("limit is held between 1 and 200, and a non-number gives 50", async () => {
    const session = await createOrgSession("wiki-page-limit");
    await seedDocuments(session.orgId, 210);
    const one = await json<DocumentsPage>("/api/knowledge/documents?limit=0", { cookies: session.cookies });
    expect(one.body.documents).toHaveLength(1);
    expect(one.body.has_more).toBe(true);
    const most = await json<DocumentsPage>("/api/knowledge/documents?limit=1000", { cookies: session.cookies });
    expect(most.body.documents).toHaveLength(200);
    const fallback = await json<DocumentsPage>("/api/knowledge/documents?limit=abc", { cookies: session.cookies });
    expect(fallback.body.documents).toHaveLength(50);
  });

  test("a malformed cursor answers 400", async () => {
    const session = await createOrgSession("wiki-page-cursor");
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const cursor of [
      "",
      "not a cursor",
      encode({ id: crypto.randomUUID() }),
      encode(["1793865600123456", crypto.randomUUID()]),
      encode([1793865600123456, "1793865600123456", crypto.randomUUID()]),
      encode(["-1", "1793865600123456", crypto.randomUUID()]),
      encode(["1793865600123456", "999999999999999999", crypto.randomUUID()]),
      encode(["1793865600123456", "1793865600123456", "not-a-uuid"]),
    ]) {
      const response = await json<{ error: string }>(
        `/api/knowledge/documents?cursor=${encodeURIComponent(cursor)}`,
        { cookies: session.cookies },
      );
      expect(response.status, cursor).toBe(400);
      expect(response.body.error).toBe("cursor is invalid");
    }
  });

  test("a cursor carries nothing across workspaces", async () => {
    const owner = await createOrgSession("wiki-page-owner");
    const other = await createOrgSession("wiki-page-other");
    await seedDocuments(owner.orgId, 3);
    await seedDocuments(other.orgId, 2);
    const first = await json<DocumentsPage>("/api/knowledge/documents?limit=1", { cookies: owner.cookies });
    const crossed = await json<DocumentsPage>(
      `/api/knowledge/documents?limit=10&cursor=${encodeURIComponent(first.body.next_cursor ?? "")}`,
      { cookies: other.cookies },
    );
    expect(crossed.status).toBe(200);
    const otherIds = new Set(await expectedOrder(other.orgId));
    expect(crossed.body.documents.every((document) => otherIds.has(document.id))).toBe(true);
  });
});

describe("wiki revision pages", () => {
  /** One document with `count` revisions, one second apart, newest last by
   *  index; indices in `sameInstant` share one creation time. */
  async function seedRevisions(
    orgId: string,
    count: number,
    sameInstant: readonly [number, number] = [-1, -1],
  ): Promise<string> {
    const [documentId] = await seedDocuments(orgId, 1, { drafts: new Set([0]) });
    await sql`DELETE FROM knowledge_revisions WHERE document_id = ${documentId!}`;
    const base = new Date(Date.now() - 3_600_000).toISOString();
    for (let index = 0; index < count; index += 1) {
      const [sameFrom, sameTo] = sameInstant;
      const offset = index >= sameFrom && index <= sameTo ? sameFrom : index;
      await sql`
        INSERT INTO knowledge_revisions (document_id, org_id, content, content_hash, created_at)
        VALUES (${documentId!}, ${orgId}, ${`Revision ${index}`}, ${`hash-${index}`},
                ${base}::timestamptz + ${offset}::int * interval '1 second')
      `;
    }
    return documentId!;
  }

  async function expectedRevisions(documentId: string): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM knowledge_revisions WHERE document_id = ${documentId}
      ORDER BY created_at DESC, id DESC
    `;
    return rows.map((row) => row.id);
  }

  test("a document answers its newest 20 revisions, and the rest page from there", async () => {
    const session = await createOrgSession("wiki-revisions");
    const documentId = await seedRevisions(session.orgId, 45, [10, 30]);
    const expected = await expectedRevisions(documentId);

    const one = await json<any>(`/api/knowledge/documents/${documentId}`, { cookies: session.cookies });
    expect(one.status).toBe(200);
    expect(one.body.document.content).toBe("Revision 44");
    expect(one.body.revisions).toHaveLength(20);
    expect(one.body.revisions[0]).toMatchObject({ content: "Revision 44" });
    expect(one.body.revisions_has_more).toBe(true);

    // The document's cursor continues on the revisions route.
    const rest: RevisionsPage[] = [];
    let cursor: string | null = one.body.revisions_next_cursor;
    while (cursor) {
      const page: { status: number; body: RevisionsPage } = await json<RevisionsPage>(
        `/api/knowledge/documents/${documentId}/revisions?cursor=${encodeURIComponent(cursor)}`,
        { cookies: session.cookies },
      );
      expect(page.status).toBe(200);
      rest.push(page.body);
      cursor = page.body.next_cursor;
      expect(rest.length).toBeLessThanOrEqual(5);
    }
    expect(rest.map((page) => page.revisions.length)).toEqual([20, 5]);
    const ids = [...one.body.revisions, ...rest.flatMap((page) => page.revisions)].map(
      (revision: { id: string }) => revision.id,
    );
    expect(ids).toEqual(expected);

    for (const limit of [1, 7]) {
      const pages = await readPages<RevisionsPage>(
        `/api/knowledge/documents/${documentId}/revisions?limit=${limit}`,
        session.cookies,
      );
      expect(pages.flatMap((page) => page.revisions.map((revision) => revision.id))).toEqual(expected);
    }
  });

  test("a document with few revisions has no next page", async () => {
    const session = await createOrgSession("wiki-revisions-few");
    const documentId = await seedRevisions(session.orgId, 2);
    const one = await json<any>(`/api/knowledge/documents/${documentId}`, { cookies: session.cookies });
    expect(one.body.revisions.map((revision: { content: string }) => revision.content)).toEqual([
      "Revision 1",
      "Revision 0",
    ]);
    expect(one.body).toMatchObject({ revisions_has_more: false, revisions_next_cursor: null });
  });

  test("a revisions limit is held between 1 and 100", async () => {
    const session = await createOrgSession("wiki-revisions-limit");
    const documentId = await seedRevisions(session.orgId, 105);
    const path = `/api/knowledge/documents/${documentId}/revisions`;
    const one = await json<RevisionsPage>(`${path}?limit=0`, { cookies: session.cookies });
    expect(one.body.revisions).toHaveLength(1);
    expect(one.body.has_more).toBe(true);
    const most = await json<RevisionsPage>(`${path}?limit=1000`, { cookies: session.cookies });
    expect(most.body.revisions).toHaveLength(100);
    const fallback = await json<RevisionsPage>(`${path}?limit=abc`, { cookies: session.cookies });
    expect(fallback.body.revisions).toHaveLength(20);
  });

  test("another workspace, a malformed id and a malformed cursor are refused", async () => {
    const owner = await createOrgSession("wiki-revisions-owner");
    const other = await createOrgSession("wiki-revisions-other");
    const documentId = await seedRevisions(owner.orgId, 3);

    for (const path of [`/api/knowledge/documents/${documentId}`, `/api/knowledge/documents/${documentId}/revisions`]) {
      const crossed = await json<{ error: string }>(path, { cookies: other.cookies });
      expect(crossed.status, path).toBe(404);
      expect(crossed.body.error).toBe("document not found");
    }
    for (const path of ["/api/knowledge/documents/not-a-uuid", "/api/knowledge/documents/not-a-uuid/revisions"]) {
      const malformed = await json<{ error: string }>(path, { cookies: owner.cookies });
      expect(malformed.status, path).toBe(404);
      expect(malformed.body.error).toBe("document not found");
    }
    const badCursor = await json<{ error: string }>(
      `/api/knowledge/documents/${documentId}/revisions?cursor=${encodeURIComponent("not a cursor")}`,
      { cookies: owner.cookies },
    );
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error).toBe("cursor is invalid");
  });
});
