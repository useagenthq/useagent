/**
 * Org API-key types. A key is exposed to the client as metadata ONLY - id,
 * name, display prefix, and timestamps. The plaintext secret is returned exactly
 * once, by the create call (CreatedApiKey.key), and is never recoverable after,
 * so only that one shape carries it.
 */

export interface ApiKeyMeta {
  id: string;
  name: string;
  /** First 12 chars of the secret (incl. the `uak_` scheme), for display. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The create response - the ONLY time the full plaintext secret is available. */
export interface CreatedApiKey extends ApiKeyMeta {
  key: string;
}
