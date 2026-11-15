import { describe, expect, test } from "bun:test";
import {
  appendOlderWikiDocs,
  fetchPublishedWikiDocument,
  fetchPublishedWikiDocuments,
  type WikiDoc,
} from "./wiki-data";

const doc = (id: string): WikiDoc => ({
  id,
  title: id,
  slug: null,
  status: "published",
  excerpt: `About ${id}.`,
  revisionId: null,
  publishedRevisionId: null,
  updatedAt: "2026-11-01T10:00:00.000Z",
  createdAt: "2026-11-01T10:00:00.000Z",
});

function answer(body: unknown, status = 200) {
  const paths: string[] = [];
  const fetcher = async (path: string) => {
    paths.push(path);
    return new Response(JSON.stringify(body), { status });
  };
  return { paths, fetcher: fetcher as never };
}

describe("fetchPublishedWikiDocuments", () => {
  test("asks for the first published page, or the page after a cursor, and reads next_cursor", async () => {
    const first = answer({ documents: [doc("a")], has_more: true, next_cursor: "c/1" });
    const page = await fetchPublishedWikiDocuments(null, first.fetcher);
    expect(first.paths).toEqual(["/api/knowledge/documents?status=published"]);
    expect(page).toEqual({ docs: [doc("a")], nextCursor: "c/1" });

    const older = answer({ documents: [], has_more: false, next_cursor: null });
    await fetchPublishedWikiDocuments("c/1", older.fetcher);
    expect(older.paths).toEqual(["/api/knowledge/documents?status=published&cursor=c%2F1"]);
  });

  test("reads a missing cursor as the last page and a missing excerpt as none", async () => {
    const { content: _content, excerpt: _excerpt, ...bare } = { ...doc("a"), content: "# a" };
    for (const next_cursor of [undefined, "", 7]) {
      const { fetcher } = answer({ documents: [bare], next_cursor });
      const page = await fetchPublishedWikiDocuments(null, fetcher);
      expect(page.nextCursor).toBeNull();
      expect(page.docs[0]?.excerpt).toBe("");
    }
  });

  test("throws on a failed answer", async () => {
    const { fetcher } = answer({ error: "list failed" }, 500);
    await expect(fetchPublishedWikiDocuments("c1", fetcher)).rejects.toThrow("wiki 500");
  });
});

describe("fetchPublishedWikiDocument", () => {
  const detail = (status: string) => ({
    document: { ...doc("d/1"), excerpt: undefined, status, content: "# d\n\nBody." },
    revisions: [],
  });

  test("reads one published document with its content", async () => {
    const one = answer(detail("published"));
    const document = await fetchPublishedWikiDocument("d/1", one.fetcher);
    expect(one.paths).toEqual(["/api/knowledge/documents/d%2F1"]);
    expect(document?.content).toBe("# d\n\nBody.");
  });

  test("is null for a missing, draft or archived document", async () => {
    expect(
      await fetchPublishedWikiDocument("x", answer({ error: "document not found" }, 404).fetcher),
    ).toBeNull();
    expect(await fetchPublishedWikiDocument("x", answer(detail("draft")).fetcher)).toBeNull();
    expect(await fetchPublishedWikiDocument("x", answer(detail("archived")).fetcher)).toBeNull();
  });

  test("throws on any other failure", async () => {
    await expect(
      fetchPublishedWikiDocument("x", answer({ error: "get failed" }, 500).fetcher),
    ).rejects.toThrow("wiki 500");
  });
});

test("an older page is added after the loaded documents without repeats", () => {
  expect(
    appendOlderWikiDocs([doc("a"), doc("b")], [doc("b"), doc("c")]).map((entry) => entry.id),
  ).toEqual(["a", "b", "c"]);
});
