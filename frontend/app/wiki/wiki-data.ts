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

/** Compact relative time for the "updated …" line. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
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
