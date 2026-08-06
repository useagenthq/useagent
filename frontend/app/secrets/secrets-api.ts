import { backendFetch } from "@/lib/backend-fetch";
import type { SecretKind, SecretMeta } from "./secrets-data";

/**
 * Thin fetch layer for the Secrets endpoints. Routing (backend origin + cookie
 * forwarding on the server, relative path on the client) lives in `backendFetch`.
 * Reads throw on a non-2xx so callers can surface the distinct "backend
 * unreachable" state; there is no value read-back call by design.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

export async function fetchSecrets(): Promise<SecretMeta[]> {
  const res = await backendFetch("/api/secrets", { cache: "no-store" });
  if (!res.ok) throw new Error(`secrets ${res.status}`);
  const data = (await res.json()) as { secrets?: SecretMeta[] };
  return data.secrets ?? [];
}

/** Upsert a secret value by name. Returns metadata only (never the value). */
export async function putSecret(
  name: string,
  value: string,
  kind: SecretKind = "env",
): Promise<SecretMeta> {
  const res = await backendFetch(`/api/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ value, kind }),
  });
  if (!res.ok) throw new Error(`put ${res.status}`);
  return (await res.json()) as SecretMeta;
}

export async function deleteSecret(name: string): Promise<void> {
  const res = await backendFetch(`/api/secrets/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`delete ${res.status}`);
}
