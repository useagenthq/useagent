import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { env } from "../env";

// ---------------------------------------------------------------------------
// Org-secret encryption (task #100). Secret values are AES-256-GCM encrypted at
// rest so a database dump never reveals them. The key is derived from
// BETTER_AUTH_SECRET via HKDF-SHA256 under a DISTINCT info string, so this key is
// independent of (and non-invertible to) the auth-cookie key and the tool-gateway
// key (mirrors knowledge/gateway/token.ts domain separation). No new dependency —
// node:crypto only, no external KMS.
//
// GCM binds an authentication tag over the ciphertext: a tampered ciphertext, iv,
// or tag makes `decipher.final()` throw, so decryption FAILS CLOSED (never returns
// forged plaintext). A random 12-byte iv per encryption keeps identical plaintexts
// distinct on disk.
// ---------------------------------------------------------------------------

const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM standard nonce length
const HKDF_INFO = "skynet-org-secrets-v1";

/** An accepted secret NAME: an environment-variable identifier - an uppercase
 *  letter followed by uppercase letters, digits, or underscores. Enforced at the
 *  API boundary AND re-checked at injection so a malformed row can never become
 *  an env key. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/** The at-rest form of a secret value: base64 ciphertext + iv + GCM tag. */
export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** Derive the 32-byte AES key. Recomputed per call (like token.ts's signingKey)
 *  — hkdfSync is cheap and this avoids stale-key hazards if the secret rotates. */
function encryptionKey(): Buffer {
  // Empty salt is fine: the ikm (BETTER_AUTH_SECRET) is already secret,
  // high-entropy key material, and the info string domain-separates this key.
  return Buffer.from(
    hkdfSync("sha256", env.BETTER_AUTH_SECRET, new Uint8Array(0), HKDF_INFO, KEY_LEN),
  );
}

/** Encrypt a plaintext secret value. Each call uses a fresh random iv. */
export function sealSecret(plaintext: string): SealedSecret {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** Decrypt a sealed secret. THROWS if the tag does not verify (tamper, wrong key,
 *  or corruption) - callers treat a throw as "skip this secret", never as
 *  plaintext. */
export function openSecret(sealed: SealedSecret): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(), // authenticates the tag; throws on any tampering
  ]);
  return plaintext.toString("utf8");
}
