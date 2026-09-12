import { backendFetch } from "@/lib/backend-fetch";
import {
  recordToItem,
  type KnowledgeItem,
  type KnowledgeRecord,
  type SearchResult,
} from "./knowledge-data";

/**
 * Thin fetch layer for the knowledge endpoints. Routing (backend origin +
 * cookie forwarding on the server, relative path on the client) lives in
 * `backendFetch`. Every call throws on a non-2xx so callers can fall back to
 * mock data or revert an optimistic update.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

export interface KnowledgeIndex {
  items: KnowledgeItem[];
  /** Backend explanation when search runs keyword-only (embeddings off or failing); null when hybrid. */
  searchNote: string | null;
}

export async function fetchKnowledge(): Promise<KnowledgeIndex> {
  const res = await backendFetch("/api/knowledge", { cache: "no-store" });
  if (!res.ok) throw new Error(`knowledge ${res.status}`);
  const data = (await res.json()) as { records?: KnowledgeRecord[]; search_note?: unknown };
  return {
    items: (data.records ?? []).map(recordToItem),
    searchNote: typeof data.search_note === "string" ? data.search_note : null,
  };
}

export interface IngestInput {
  name: string;
  trigger: string;
  content: string;
  folder: string;
}

/**
 * Mirrors the backend `IngestResult` (backend/src/knowledge/ingest.ts) — keep the
 * status union in sync. `id` is null for the non-storing outcomes: `dropped`
 * (worth_saving gate) and `deferred` (distillation unavailable in production, so
 * NOTHING was stored and the caller should retry once the model is healthy). A
 * silent success on `deferred` is the bug this type prevents.
 */
export interface IngestResult {
  id: string | null;
  status: "stored" | "skipped" | "dropped" | "deferred";
  kind?: string;
}

/** A refused upload: `code` is the backend's reason (unsupported_type,
 *  file_too_large, empty_document, unreadable_document) or null on transport failure. */
export class KnowledgeUploadError extends Error {
  constructor(
    readonly code: string | null,
    readonly status: number | null,
  ) {
    super(code ?? "upload failed");
    this.name = "KnowledgeUploadError";
  }
}

/** Send one document (.md, .txt, .pdf) to `/api/knowledge/upload`; the backend
 *  extracts its text and runs the same ingest as a pasted note. */
export async function uploadKnowledgeDocument(
  file: File,
  folder: string,
): Promise<IngestResult> {
  const form = new FormData();
  form.set("file", file);
  form.set("folder", folder);
  const res = await backendFetch("/api/knowledge/upload", { method: "POST", body: form });
  const body = (await res.json().catch(() => null)) as
    | (IngestResult & { error?: unknown })
    | { error?: unknown }
    | null;
  if (!res.ok) {
    throw new KnowledgeUploadError(
      typeof body?.error === "string" ? body.error : null,
      res.status,
    );
  }
  if (!body || !("status" in body)) throw new KnowledgeUploadError(null, res.status);
  return body;
}

export async function ingestKnowledge(
  input: IngestInput,
): Promise<IngestResult> {
  const text = `${input.name}\n\nWhen to recall: ${input.trigger}\n\n${input.content}`;
  const res = await backendFetch("/api/knowledge/ingest", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      meta: {
        source_type: "document",
        external_id: crypto.randomUUID(),
        connector_instance_id: "manual:web",
        created_at: new Date().toISOString(),
        domain: input.folder,
      },
      text,
    }),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}`);
  return (await res.json()) as IngestResult;
}

export async function searchKnowledge(
  query: string,
  k = 8,
): Promise<SearchResult[]> {
  const res = await backendFetch("/api/knowledge/search", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ query, k }),
  });
  if (!res.ok) throw new Error(`search ${res.status}`);
  const data = (await res.json()) as { results?: SearchResult[] };
  return data.results ?? [];
}

export async function setKnowledgePinned(
  id: string,
  pinned: boolean,
): Promise<void> {
  const res = await backendFetch(`/api/knowledge/${id}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ pinned }),
  });
  if (!res.ok) throw new Error(`pin ${res.status}`);
}

export async function deleteKnowledge(id: string): Promise<void> {
  const res = await backendFetch(`/api/knowledge/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete ${res.status}`);
}
