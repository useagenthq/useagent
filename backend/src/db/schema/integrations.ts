import {
  INTEGRATION_CONNECTION_STATUSES,
  type IntegrationConnectionAccount,
  type IntegrationConnectionStatus,
} from "@useagent/agent-client/integrations";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export { INTEGRATION_CONNECTION_STATUSES };
export type { IntegrationConnectionAccount, IntegrationConnectionStatus };

export const INTEGRATION_CONNECTION_OWNER_TYPES = ["org", "user"] as const;
export type IntegrationConnectionOwnerType =
  (typeof INTEGRATION_CONNECTION_OWNER_TYPES)[number];

export const INTEGRATION_CONNECTION_AUTH_METHODS = [
  "oauth2",
  "api_key",
  "custom_credential",
] as const;
export type IntegrationConnectionAuthMethod =
  (typeof INTEGRATION_CONNECTION_AUTH_METHODS)[number];

// ---------------------------------------------------------------------------
// Integration connections — browser-safe tenant-owned projections for SaaS
// accounts whose credential material remains in the connection backend. These
// rows contain no access tokens, refresh tokens, OAuth client secrets, runtime
// tokens, callback payloads, or raw provider responses.
// ---------------------------------------------------------------------------

export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    ownerType: text("owner_type").$type<IntegrationConnectionOwnerType>().notNull(),
    ownerUserId: text("owner_user_id"),
    provider: text("provider").notNull(),
    runtimeBindingId: text("runtime_binding_id").notNull(),
    externalConnectionId: text("external_connection_id").notNull(),
    externalConnectionName: text("external_connection_name"),
    status: text("status").$type<IntegrationConnectionStatus>().notNull(),
    authMethod: text("auth_method").$type<IntegrationConnectionAuthMethod>().notNull(),
    accountMetadata: jsonb("account_metadata")
      .$type<IntegrationConnectionAccount>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdByUserId: text("created_by_user_id").notNull(),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "integration_connections_owner_type_check",
      sql`${t.ownerType} IN ('org', 'user')`,
    ),
    check(
      "integration_connections_owner_check",
      sql`(${t.ownerType} = 'org' AND ${t.ownerUserId} IS NULL) OR (${t.ownerType} = 'user' AND ${t.ownerUserId} IS NOT NULL)`,
    ),
    check(
      "integration_connections_status_check",
      sql`${t.status} IN ('connecting', 'connected', 'reauth_required', 'unhealthy', 'revoked')`,
    ),
    check(
      "integration_connections_auth_method_check",
      sql`${t.authMethod} IN ('oauth2', 'api_key', 'custom_credential')`,
    ),
    check(
      "integration_connections_account_metadata_safe_check",
      sql`jsonb_typeof(${t.accountMetadata}) = 'object' AND (${t.accountMetadata} - 'externalAccountId' - 'displayName' - 'email' - 'avatarUrl') = '{}'::jsonb AND (NOT (${t.accountMetadata} ? 'externalAccountId') OR jsonb_typeof(${t.accountMetadata}->'externalAccountId') = 'string') AND (NOT (${t.accountMetadata} ? 'displayName') OR jsonb_typeof(${t.accountMetadata}->'displayName') = 'string') AND (NOT (${t.accountMetadata} ? 'email') OR jsonb_typeof(${t.accountMetadata}->'email') = 'string') AND (NOT (${t.accountMetadata} ? 'avatarUrl') OR jsonb_typeof(${t.accountMetadata}->'avatarUrl') = 'string')`,
    ),
    check("integration_connections_scopes_array_check", sql`jsonb_typeof(${t.scopes}) = 'array'`),
    index("idx_integration_connections_org_owner").on(t.orgId, t.ownerType, t.ownerUserId),
    index("idx_integration_connections_connected_org")
      .on(t.orgId, t.runtimeBindingId, t.provider)
      .where(sql`${t.ownerType} = 'org' AND ${t.status} = 'connected'`),
    uniqueIndex("uq_integration_connections_external_scope").on(
      t.orgId,
      t.runtimeBindingId,
      t.provider,
      t.externalConnectionId,
    ),
    uniqueIndex("uq_integration_connections_external_identity").on(
      t.runtimeBindingId,
      t.provider,
      t.externalConnectionId,
    ),
  ],
);

// Server-only credential material for native integration backends. The parent
// connection remains browser-safe; this row is decrypted only by trusted
// provider adapters and is deleted when the connection is revoked.
export const integrationConnectionCredentials = pgTable(
  "integration_connection_credentials",
  {
    connectionId: uuid("connection_id")
      .primaryKey()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    provider: text("provider").notNull(),
    externalConnectionId: text("external_connection_id").notNull(),
    format: text("format").notNull(),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_integration_connection_credentials_identity").on(
      t.orgId,
      t.provider,
      t.externalConnectionId,
    ),
  ],
);

// OAuth/connect state is local, hashed, expiring, and one-shot. The remote
// backend reference is opaque and never returned through browser-safe shapes.
export const integrationConnectSessions = pgTable(
  "integration_connect_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    ownerType: text("owner_type").$type<IntegrationConnectionOwnerType>().notNull(),
    ownerUserId: text("owner_user_id"),
    provider: text("provider").notNull(),
    runtimeBindingId: text("runtime_binding_id").notNull(),
    backendSessionRef: text("backend_session_ref").notNull(),
    stateHash: text("state_hash").notNull(),
    returnTo: text("return_to").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    processingToken: text("processing_token"),
    processingExpiresAt: timestamp("processing_expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "integration_connect_sessions_owner_type_check",
      sql`${t.ownerType} IN ('org', 'user')`,
    ),
    check(
      "integration_connect_sessions_owner_check",
      sql`(${t.ownerType} = 'org' AND ${t.ownerUserId} IS NULL) OR (${t.ownerType} = 'user' AND ${t.ownerUserId} IS NOT NULL)`,
    ),
    check(
      "integration_connect_sessions_state_hash_check",
      sql`${t.stateHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "integration_connect_sessions_return_to_check",
      sql`left(${t.returnTo}, 1) = '/' AND left(${t.returnTo}, 2) <> '//' AND position(E'\\' in ${t.returnTo}) = 0`,
    ),
    uniqueIndex("uq_integration_connect_sessions_state_hash").on(t.stateHash),
    index("idx_integration_connect_sessions_actor").on(t.orgId, t.actorUserId, t.expiresAt),
    index("idx_integration_connect_sessions_processing")
      .on(t.processingExpiresAt)
      .where(sql`${t.processingToken} is not null`),
  ],
);
