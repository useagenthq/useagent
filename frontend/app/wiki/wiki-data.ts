import { backendFetch } from "@/lib/backend-fetch";

/** A published wiki document as returned by GET /api/knowledge/documents. */
export interface WikiDoc {
  id: string;
  title: string;
  slug: string | null;
  status: string;
  content: string;
  revisionId: string | null;
  publishedRevisionId: string | null;
  updatedAt: string;
  createdAt: string;
}

/** Stable, unique anchor id for a document's section (deep-linkable). */
export function sectionId(doc: WikiDoc): string {
  return `doc-${doc.id.slice(0, 8)}`;
}

/**
 * Fetch the org's PUBLISHED wiki documents (mem_op.md 0.3). Throws on non-2xx so
 * the server page can fall back to an empty state. Routing + cookie forwarding
 * live in `backendFetch`.
 */
export async function fetchPublishedWikiDocuments(): Promise<WikiDoc[]> {
  const res = await backendFetch("/api/knowledge/documents?status=published", { cache: "no-store" });
  if (!res.ok) throw new Error(`wiki ${res.status}`);
  const data = (await res.json()) as { documents?: WikiDoc[] };
  return data.documents ?? [];
}
