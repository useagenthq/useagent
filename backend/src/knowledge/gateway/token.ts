import { createHmac, timingSafeEqual } from "node:crypto";
import { authSecretMaterial } from "../../security/runtime-secrets";

// ---------------------------------------------------------------------------
// Run-scoped tool token — THE trust boundary for the agent-callable knowledge
// gateway (mem_op.md 0.2 / new_prompt.md "Trusted Tool Gateway").
//
// The untrusted sandbox NEVER holds DB/embedding/tenant credentials. It holds
// ONLY this short-lived, signed token. The gateway derives the authorized
// org/user/thread/run FROM THE TOKEN, server-side — it never accepts a tenant id
// from a tool argument. A tampered, forged, or expired token yields `null` here,
// and the gateway fails closed (401 / not-found). This is a HARD rule (mem_op.md
// "Rules model"): enforced in code, never as prompt text.
//
// Stateless HMAC design (no token table, no migration): the token is
//   v1.<base64url(payloadJSON)>.<base64url(HMAC-SHA256(v1.<payload>, key))>
// Public gateway deployments require a dedicated TOOL_GATEWAY_SECRET. An
// auth-root-derived key remains only for loopback local development, and is
// domain-separated so a gateway token can never be confused for a session.
// Revocation is by expiry plus exact-run liveness.
// ---------------------------------------------------------------------------

const VERSION = "v1";
const DERIVE_LABEL = "skynet-tool-gateway-v1";

/** How the capability binds to a turn (perf run-invariant-config slice):
 *  "run" (legacy default) is inert unless the exact minted run is running now;
 *  "thread" is inert unless THIS thread has a currently-running turn - the
 *  gateway resolves that live run per call and attributes to it. Thread scope
 *  exists so a resident process's config can stay byte-stable across warm
 *  turns; outside a live turn both scopes fail closed, and TTL is unchanged. */
export type ToolTokenScope = "run" | "thread";

/** The identity a verified token authorizes. Every field is server-trusted:
 *  the gateway uses these, and ONLY these, to scope a tool call. */
export interface ToolTokenClaims {
  orgId: string;
  /** The run's user (provenance / actorUserId). "" when the run had no user. */
  userId: string;
  threadId: string;
  /** The run this token was minted for. Ledger attribution resolves the thread's
   *  currently-active run at call time and falls back to this. */
  runId: string;
  scope: ToolTokenScope;
  /** Expiry, epoch ms. A token past this is rejected (fail closed). */
  exp: number;
}

/** Wire payload — short keys keep the token compact. */
interface WirePayload {
  o: string;
  u: string;
  t: string;
  r: string;
  e: number;
  /** Scope marker; absent (legacy tokens) means "run". */
  k?: "t";
}

/** Signing key, derived once. TOOL_GATEWAY_SECRET overrides the derivation. */
function signingKey(): Buffer {
  const explicit = process.env.TOOL_GATEWAY_SECRET?.trim();
  if (explicit) return Buffer.from(explicit, "utf8");
  // Domain-separated HKDF-lite: HMAC the auth secret under a fixed label so the
  // gateway key is independent of (and non-invertible to) the cookie key.
  return createHmac("sha256", authSecretMaterial()).update(DERIVE_LABEL).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(signingInput: string): string {
  return b64url(createHmac("sha256", signingKey()).update(signingInput).digest());
}

/** Mint a token for one run's execution. TTL is bounded by the caller. */
export function mintToolToken(
  claims: Omit<ToolTokenClaims, "exp" | "scope"> & { scope?: ToolTokenScope },
  ttlMs: number,
): string {
  const payload: WirePayload = {
    o: claims.orgId,
    u: claims.userId,
    t: claims.threadId,
    r: claims.runId,
    ...(claims.scope === "thread" ? { k: "t" as const } : {}),
    // No clamp: a caller that passes a non-positive TTL gets an already-expired
    // token, which correctly fails closed. Production callers always pass a
    // bounded positive TTL (toolGatewayConfig validates > 0).
    e: Date.now() + ttlMs,
  };
  const body = `${VERSION}.${b64url(Buffer.from(JSON.stringify(payload), "utf8"))}`;
  return `${body}.${sign(body)}`;
}

/**
 * Verify + decode a token. Returns the claims, or `null` for ANY failure —
 * malformed, wrong version, bad signature, expired, or missing/empty org.
 * Constant-time signature comparison (no early-exit timing leak). This function
 * is the only place a token becomes identity; callers must treat `null` as
 * "unauthorized" and fail closed.
 */
export function verifyToolToken(token: string | null | undefined, nowMs = Date.now()): ToolTokenClaims | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, payloadB64, sigB64] = parts as [string, string, string];
  if (version !== VERSION) return null;

  // Recompute the signature over the exact signing input and compare in
  // constant time. A length mismatch is itself a rejection (timingSafeEqual
  // throws on unequal lengths, so guard first).
  const expected = sign(`${version}.${payloadB64}`);
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let wire: WirePayload;
  try {
    wire = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as WirePayload;
  } catch {
    return null;
  }
  if (
    typeof wire.o !== "string" ||
    typeof wire.t !== "string" ||
    typeof wire.r !== "string" ||
    typeof wire.e !== "number"
  ) {
    return null;
  }
  if (!wire.o) return null; // no org → no identity → reject
  if (wire.e <= nowMs) return null; // expired
  if (wire.k !== undefined && wire.k !== "t") return null;

  return {
    orgId: wire.o,
    userId: typeof wire.u === "string" ? wire.u : "",
    threadId: wire.t,
    runId: wire.r,
    scope: wire.k === "t" ? "thread" : "run",
    exp: wire.e,
  };
}
