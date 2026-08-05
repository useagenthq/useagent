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

export async function fetchKnowledgeItems(): Promise<KnowledgeItem[]> {
  const res = await backendFetch("/api/knowledge", { cache: "no-store" });
  if (!res.ok) throw new Error(`knowledge ${res.status}`);
  const data = (await res.json()) as { records?: KnowledgeRecord[] };
  return (data.records ?? []).map(recordToItem);
}

export interface IngestInput {
  name: string;
  trigger: string;
  content: string;
  folder: string;
}

export interface IngestResult {
  id: string;
  status: "stored" | "skipped" | "dropped";
  kind?: string;
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
