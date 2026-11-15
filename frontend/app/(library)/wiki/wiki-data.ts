import { backendFetch } from "@/lib/backend-fetch";

/** A published wiki document as listed by GET /api/knowledge/documents: an
 *  excerpt of its content, not the content itself. */
export interface WikiDoc {
  id: string;
  title: string;
  slug: string | null;
  status: string;
  /** The first line of prose, for a preview; "" when there is none. */
  excerpt: string;
  revisionId: string | null;
  publishedRevisionId: string | null;
  updatedAt: string;
  createdAt: string;
}

/** One document as GET /api/knowledge/documents/:id answers it, with its content. */
export interface WikiDocDetail extends Omit<WikiDoc, "excerpt"> {
  content: string;
}

export interface WikiDocListPage {
  docs: WikiDoc[];
  /** Cursor for the page after this one; null on the last page. */
  nextCursor: string | null;
}

/** Stable, unique anchor id for a document's section (deep-linkable). */
export function sectionId(doc: WikiDoc): string {
  return `doc-${doc.id.slice(0, 8)}`;
}

/**
 * One page of the org's PUBLISHED wiki documents (mem_op.md 0.3), newest update
 * first: the first page, or the one after `cursor`. Throws on non-2xx so a
 * server page can show the outage instead of an empty wiki. Routing + cookie
 * forwarding live in `backendFetch`.
 */
export async function fetchPublishedWikiDocuments(
  cursor: string | null = null,
  fetcher: typeof backendFetch = backendFetch,
): Promise<WikiDocListPage> {
  const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
  const res = await fetcher(`/api/knowledge/documents?status=published${query}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`wiki ${res.status}`);
  const data = (await res.json()) as { documents?: WikiDoc[]; next_cursor?: unknown };
  return {
    docs: (data.documents ?? []).map((doc) => ({
      ...doc,
      excerpt: typeof doc.excerpt === "string" ? doc.excerpt : "",
    })),
    nextCursor:
      typeof data.next_cursor === "string" && data.next_cursor.length > 0 ? data.next_cursor : null,
  };
}

/**
 * One PUBLISHED document with its content, read directly so a document past
 * the first list page opens too. Null when it does not exist (or the id is
 * malformed) and when it is a draft or archived: the Wiki shows published
 * documents only. Throws on any other failure.
 */
export async function fetchPublishedWikiDocument(
  id: string,
  fetcher: typeof backendFetch = backendFetch,
): Promise<WikiDocDetail | null> {
  const res = await fetcher(`/api/knowledge/documents/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`wiki ${res.status}`);
  const data = (await res.json()) as { document?: WikiDocDetail };
  return data.document?.status === "published" ? data.document : null;
}

/** Add an older page after what is loaded, without repeating a document already shown. */
export function appendOlderWikiDocs(loaded: readonly WikiDoc[], older: readonly WikiDoc[]): WikiDoc[] {
  const ids = new Set(loaded.map((doc) => doc.id));
  return [...loaded, ...older.filter((doc) => !ids.has(doc.id))];
}
