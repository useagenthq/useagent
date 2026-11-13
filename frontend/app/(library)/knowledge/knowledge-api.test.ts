import { describe, expect, test } from "bun:test";
import { appendOlderPage, fetchKnowledge, mergeNewestPage } from "./knowledge-api";
import { recordToItem } from "./knowledge-data";

const item = (id: string) =>
  recordToItem({
    id,
    kind: "reference" as const,
    title: id,
    body: "",
    pinned: false,
    created_at: "2026-11-01T10:00:00.000Z",
  });
const ids = (list: readonly { id: string }[]) => list.map((entry) => entry.id);

function answer(body: unknown, status = 200) {
  const paths: string[] = [];
  const fetcher = async (path: string) => {
    paths.push(path);
    return new Response(JSON.stringify(body), { status });
  };
  return { paths, fetcher: fetcher as never };
}

describe("fetchKnowledge", () => {
  test("asks for the newest page, or the page after a cursor, and reads next_cursor", async () => {
    const newest = answer({
      records: [{ id: "a", title: "a" }],
      next_cursor: "c/1",
      search_note: null,
    });
    const page = await fetchKnowledge(null, newest.fetcher);
    expect(newest.paths).toEqual(["/api/knowledge"]);
    expect(page.nextCursor).toBe("c/1");
    expect(ids(page.items)).toEqual(["a"]);

    const older = answer({ records: [], next_cursor: null });
    await fetchKnowledge("c/1", older.fetcher);
    expect(older.paths).toEqual(["/api/knowledge?cursor=c%2F1"]);
  });

  test("reads a missing, empty or non-string cursor as the last page", async () => {
    for (const next_cursor of [undefined, "", 7]) {
      const { fetcher } = answer({ records: [], next_cursor });
      expect((await fetchKnowledge(null, fetcher)).nextCursor).toBeNull();
    }
  });

  test("throws on a failed answer", async () => {
    const { fetcher } = answer({ error: "list failed" }, 500);
    await expect(fetchKnowledge("c1", fetcher)).rejects.toThrow("knowledge 500");
  });
});

describe("page merging", () => {
  test("a refreshed newest page goes in front and loaded records it no longer holds stay after it", () => {
    expect(ids(mergeNewestPage([item("n"), item("a")], [item("a"), item("b"), item("c")]))).toEqual(
      ["n", "a", "b", "c"],
    );
  });

  test("an older page goes after the loaded records without repeating one", () => {
    expect(ids(appendOlderPage([item("a"), item("b")], [item("b"), item("c")]))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
