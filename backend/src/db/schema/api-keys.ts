import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Org API keys — long-lived bearer credentials that let a LOCAL script act on
// its owner's organization for a narrow, read-plus-dispatch route allowlist
// (see src/middleware/bearer.ts). Auth today is better-auth session cookies; an
// API key is the non-interactive lane for local-to-cloud fleet dispatch.
//
// SECURITY POSTURE:
//  - Only the SHA-256 hash of the full secret is stored (`keyHash`); the
//    plaintext `uak_...` token is shown ONCE in the create response and is never
//    recoverable afterward. A database leak yields hashes, not usable keys.
//  - `keyPrefix` is the first 12 chars (incl. the `uak_` scheme) kept in the
//    clear purely for display/disambiguation in the management UI.
//  - Revocation is a soft delete: `revokedAt` is stamped and the row is kept so
//    the bearer lane can reject a revoked key and the owner keeps an audit trail.
//  - `lastUsedAt` is a throttled (>=60s) fire-and-forget stamp for "when did this
//    key last authenticate" — never on the hot path of the request it serves.
// ---------------------------------------------------------------------------

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    // The member who minted the key. Bearer requests act as this user (the same
    // context orgScope sets from a session), so run authorship stays honest.
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    // SHA-256 hex of the full `uak_...` secret. Globally unique: the lookup keys
    // on it and no two secrets can collide.
    keyHash: text("key_hash").notNull(),
    // First 12 chars of the secret (incl. `uak_`) for display only.
    keyPrefix: text("key_prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uq_api_keys_key_hash").on(t.keyHash),
    index("idx_api_keys_org").on(t.orgId),
  ],
);
