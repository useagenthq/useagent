import { createHmac, timingSafeEqual } from "node:crypto";
import { authSecretMaterial } from "./runtime-secrets";

const VERSION = "v1";

export interface SignedCapabilityOptions {
  /** Domain-separates this capability from cookies and every other token family. */
  readonly deriveLabel: string;
  /** Optional dedicated secret. The auth secret is only the fallback key material. */
  readonly explicitSecret?: string | undefined;
}

interface CapabilityEnvelope<T> {
  readonly claims: T;
  readonly exp: number;
}

function signingKey(options: SignedCapabilityOptions): Buffer {
  const explicit = options.explicitSecret?.trim();
  if (explicit) return Buffer.from(explicit, "utf8");
  return createHmac("sha256", authSecretMaterial())
    .update(options.deriveLabel)
    .digest();
}

function signature(input: string, options: SignedCapabilityOptions): Buffer {
  return createHmac("sha256", signingKey(options)).update(input).digest();
}

/**
 * Mint a compact, stateless capability. A non-positive TTL intentionally creates
 * an already-expired token; callers own their policy bounds.
 */
export function mintSignedCapability<T extends object>(
  claims: T,
  ttlMs: number,
  options: SignedCapabilityOptions,
): string {
  const envelope: CapabilityEnvelope<T> = { claims, exp: Date.now() + ttlMs };
  const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  const input = `${VERSION}.${payload}`;
  return `${input}.${signature(input, options).toString("base64url")}`;
}

/** Verify signature + expiry, returning untrusted decoded claims for caller validation. */
export function verifySignedCapability(
  token: string | null | undefined,
  options: SignedCapabilityOptions,
  nowMs = Date.now(),
): { claims: unknown; exp: number } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, payload, encodedSignature] = parts as [string, string, string];
  if (version !== VERSION) return null;

  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  const expected = signature(`${version}.${payload}`, options);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object") return null;
  const candidate = envelope as Partial<CapabilityEnvelope<unknown>>;
  if (typeof candidate.exp !== "number" || !Number.isFinite(candidate.exp) || candidate.exp <= nowMs) {
    return null;
  }
  return { claims: candidate.claims, exp: candidate.exp };
}
