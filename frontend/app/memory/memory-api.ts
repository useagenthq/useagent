import { backendFetch } from "@/lib/backend-fetch";
import type {
  BrowseResponse,
  CaptureRow,
  MemoryScope,
  RecallLedgerRow,
  SearchResponse,
} from "./memory-data";

/**
 * Thin fetch layer for the Memory Hub endpoints. Routing (backend origin +
 * cookie forwarding on the server, relative path on the client) lives in
 * `backendFetch`. Reads throw on a non-2xx so callers can surface the distinct
 * "backend unreachable" state; mutations return the parsed result.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

export async function fetchBrowse(scope: MemoryScope): Promise<BrowseResponse> {
  const res = await backendFetch(`/api/memory/browse?scope=${scope}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`browse ${res.status}`);
  return (await res.json()) as BrowseResponse;
}

export async function searchMemory(scope: MemoryScope, query: string): Promise<SearchResponse> {
  const res = await backendFetch(
    `/api/memory/search?scope=${scope}&q=${encodeURIComponent(query)}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`search ${res.status}`);
  return (await res.json()) as SearchResponse;
}

export async function correctMemory(
  id: string,
  scope: MemoryScope,
  content: string,
  background?: string,
): Promise<void> {
  const res = await backendFetch(`/api/memory/item/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ scope, content, background }),
  });
  if (!res.ok) throw new Error(`correct ${res.status}`);
}

export async function deleteMemory(id: string, scope: MemoryScope): Promise<void> {
  const res = await backendFetch(
    `/api/memory/item/${encodeURIComponent(id)}?scope=${scope}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`delete ${res.status}`);
}

export async function fetchCaptures(): Promise<CaptureRow[]> {
  const res = await backendFetch("/api/memory/captures", { cache: "no-store" });
  if (!res.ok) throw new Error(`captures ${res.status}`);
  const data = (await res.json()) as { captures?: CaptureRow[] };
  return data.captures ?? [];
}

export async function retryCapture(runId: string): Promise<void> {
  const res = await backendFetch(`/api/memory/captures/${encodeURIComponent(runId)}/retry`, {
    method: "POST",
    headers: jsonHeaders,
  });
  if (!res.ok) throw new Error(`retry ${res.status}`);
}

export async function resolveCapture(
  runId: string,
  resolution: "delivered" | "discard",
): Promise<void> {
  const res = await backendFetch(`/api/memory/captures/${encodeURIComponent(runId)}/resolve`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ resolution }),
  });
  if (!res.ok) throw new Error(`resolve ${res.status}`);
}

export async function fetchRecalls(): Promise<RecallLedgerRow[]> {
  const res = await backendFetch("/api/memory/recalls", { cache: "no-store" });
  if (!res.ok) throw new Error(`recalls ${res.status}`);
  const data = (await res.json()) as { recalls?: RecallLedgerRow[] };
  return data.recalls ?? [];
}
