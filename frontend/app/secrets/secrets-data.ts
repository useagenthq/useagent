/**
 * Org Secrets types (task #100). A secret is exposed to the client as metadata
 * ONLY - a name and its timestamps. The plaintext value is write-only at the API
 * boundary and never leaves the backend, so there is no `value` field here.
 */

/** How a secret reaches the sandbox - an env var ("env") or a materialized file
 *  whose PATH becomes the env var ("file"). Mirrors the backend SecretKind. */
export const SECRET_KINDS = ["env", "file"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export interface SecretMeta {
  name: string;
  kind: SecretKind;
  createdAt: string;
  updatedAt: string;
}

/**
 * The accepted secret-name grammar, mirrored from the backend
 * (src/secrets/crypto.ts) so the UI can validate before a round-trip and guide
 * the user inline. An env-var identifier: an uppercase letter followed by
 * uppercase letters, digits, or underscores.
 */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}
