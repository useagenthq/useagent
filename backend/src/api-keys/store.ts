import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { apiKeys } from "../db/schema";

// ---------------------------------------------------------------------------
// Org API-key data access. The plaintext secret exists ONLY in the create
// response; at rest we keep its SHA-256 hash (for lookup) plus a 12-char prefix
// (for display). Revocation is a soft delete. See db/schema/api-keys.ts and
// middleware/bearer.ts for the full posture.
// ---------------------------------------------------------------------------

/** The key scheme prefix. A full secret is `uak_` + 40 base64url chars. */
export const API_KEY_PREFIX = "uak_";
/** Chars of the full secret kept in the clear for display (incl. the scheme). */
const DISPLAY_PREFIX_LEN = 12;

/** SHA-256 hex of a full `uak_...` secret. The single hashing seam so lookup and
 *  storage can never disagree. */
export function hashApiKey(fullKey: string): string {
  return createHash("sha256").update(fullKey).digest("hex");
}

/** Mint a fresh secret: `uak_` + base64url(30 random bytes) = 44 chars total, 40
 *  chars of entropy (240 bits). Returns the plaintext (shown once), its hash,
 *  and its display prefix. Module-private: `createApiKey` is the public seam. */
function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `${API_KEY_PREFIX}${randomBytes(30).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, DISPLAY_PREFIX_LEN) };
}

/** Public metadata shape at the API boundary. NEVER carries the secret or hash. */
export interface ApiKeyMeta {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

type ApiKeyRow = typeof apiKeys.$inferSelect;

function toMeta(r: ApiKeyRow): ApiKeyMeta {
  return {
    id: r.id,
    name: r.name,
    prefix: r.keyPrefix,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  };
}

/** Result of a create: metadata plus the ONE-TIME plaintext secret. */
export interface CreatedApiKey extends ApiKeyMeta {
  key: string;
}

/** Mint and persist a key for (org, user). Only the hash + prefix are stored;
 *  the returned `key` is the sole time the plaintext is available. */
export async function createApiKey(
  orgId: string,
  userId: string,
  name: string,
): Promise<CreatedApiKey> {
  const { key, hash, prefix } = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({ orgId, userId, name, keyHash: hash, keyPrefix: prefix })
    .returning();
  if (!row) throw new Error("api key insert returned no row");
  return { ...toMeta(row), key };
}

/** List an org's keys (newest first), metadata only - never the secret or hash.
 *  Includes revoked keys so the owner keeps an audit trail. */
export async function listApiKeys(orgId: string): Promise<ApiKeyMeta[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.orgId, orgId))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map(toMeta);
}

/** Soft-delete (revoke) a key by id, org-scoped. Idempotent: stamps revoked_at
 *  only on a still-active row. Returns true when a row was newly revoked; a
 *  cross-org id, an unknown id, or an already-revoked key returns false. */
export async function revokeApiKey(orgId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

/** The bearer-lane view of an authenticated key: enough to set request context
 *  and drive the last-used throttle. */
export interface ActiveApiKey {
  id: string;
  orgId: string;
  userId: string;
  lastUsedAt: Date | null;
}

/** Resolve a NON-REVOKED key by the hash of its presented secret. Returns null
 *  on any miss (unknown or revoked) so the bearer lane fails closed. */
export async function findActiveApiKeyByHash(hash: string): Promise<ActiveApiKey | null> {
  const [row] = await db
    .select({
      id: apiKeys.id,
      orgId: apiKeys.orgId,
      userId: apiKeys.userId,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);
  if (!row || row.revokedAt) return null;
  return { id: row.id, orgId: row.orgId, userId: row.userId, lastUsedAt: row.lastUsedAt };
}

/** Stamp last_used_at = now for a key id. Called fire-and-forget off the hot
 *  path; the caller owns the >=60s throttle so this is a bare write. */
export async function touchApiKeyLastUsed(id: string): Promise<void> {
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, id));
}
