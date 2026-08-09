import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { authSecretMaterial, runtimeDevModeEnabled } from "../security/runtime-secrets";

// ---------------------------------------------------------------------------
// Org-secret encryption (task #100). Secret values are AES-256-GCM encrypted at
// rest so a database dump never reveals them. Production uses the dedicated
// SECRETS_ENCRYPTION_KEY root; local development can derive from the auth root.
// Legacy rows remain readable during rotation when the old auth root is present.
// No new dependency — node:crypto only, no external KMS.
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

/** Names that alter shell/runtime bootstrap or redirect trusted traffic. They
 * are never valid user-managed sandbox secrets, even if a legacy row bypassed
 * the HTTP validation. Provider credential names are intentionally absent:
 * admins store those here, while the engine boundary withholds them and the
 * trusted provider gateway resolves them by exact name. */
export const RESERVED_SECRET_NAMES = new Set([
  "BASH_ENV",
  "ENV",
  "HOME",
  "PATH",
  "SHELL",
  "SHELLOPTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENROUTER_BASE_URL",
]);

export function isValidSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

export function isReservedSecretName(name: string): boolean {
  return RESERVED_SECRET_NAMES.has(name);
}

/** The at-rest form of a secret value: base64 ciphertext + iv + GCM tag. */
export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** Derive the 32-byte AES key. Recomputed per call (like token.ts's signingKey)
 *  — hkdfSync is cheap and this avoids stale-key hazards if the secret rotates. */
function encryptionMaterial(): string {
  const dedicated = process.env.SECRETS_ENCRYPTION_KEY?.trim();
  if (dedicated) {
    if (dedicated.length < 32) {
      throw new Error("SECRETS_ENCRYPTION_KEY must be at least 32 characters");
    }
    return dedicated;
  }
  if (!runtimeDevModeEnabled()) {
    throw new Error("SECRETS_ENCRYPTION_KEY is required when SKYNET_DEV_MODE is off");
  }
  return authSecretMaterial();
}

function encryptionKey(material = encryptionMaterial()): Buffer {
  // Empty salt is fine: the input is already secret,
  // high-entropy key material, and the info string domain-separates this key.
  return Buffer.from(
    hkdfSync("sha256", material, new Uint8Array(0), HKDF_INFO, KEY_LEN),
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
  const decrypt = (key: Buffer): string => {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(sealed.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  };
  try {
    return decrypt(encryptionKey());
  } catch (primaryError) {
    // Migration compatibility: a newly configured dedicated root can still
    // read legacy rows sealed under BETTER_AUTH_SECRET until an admin re-saves
    // them. A gateway without that legacy root remains narrow and fails closed.
    const dedicated = process.env.SECRETS_ENCRYPTION_KEY?.trim();
    const legacy = process.env.BETTER_AUTH_SECRET?.trim();
    if (!dedicated || !legacy || dedicated === legacy) throw primaryError;
    return decrypt(encryptionKey(legacy));
  }
}
