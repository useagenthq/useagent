import { backendFetch } from "@/lib/backend-fetch";
import type { ApiKeyMeta, CreatedApiKey } from "./api-keys-data";

/**
 * Thin fetch layer for the API-keys endpoints. Routing (backend origin + cookie
 * forwarding on the server, relative path on the client) lives in `backendFetch`.
 * Reads throw on a non-2xx so callers can surface the distinct "backend
 * unreachable" state. These routes are SESSION-authenticated: a bearer API key
 * cannot manage keys, so this layer never sends one.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

export async function fetchApiKeys(): Promise<ApiKeyMeta[]> {
  const res = await backendFetch("/api/api-keys", { cache: "no-store" });
  if (!res.ok) throw new Error(`api-keys ${res.status}`);
  const data = (await res.json()) as { keys?: ApiKeyMeta[] };
  return data.keys ?? [];
}

/** Create a key. The response carries the plaintext secret ONE time. */
export async function createApiKey(name: string): Promise<CreatedApiKey> {
  const res = await backendFetch("/api/api-keys", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`create ${res.status}`);
  return (await res.json()) as CreatedApiKey;
}

/** Revoke a key by id (soft delete on the backend; the row is kept). */
export async function revokeApiKey(id: string): Promise<void> {
  const res = await backendFetch(`/api/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`revoke ${res.status}`);
}
