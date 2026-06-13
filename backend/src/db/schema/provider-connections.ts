import {
  PROVIDER_CONNECTION_AUTH_METHODS,
  PROVIDER_CONNECTION_PROVIDERS,
  PROVIDER_CONNECTION_STATUSES,
  type ProviderConnectionAuthMethod,
  type ProviderConnectionMetadata,
  type ProviderConnectionProvider,
  type ProviderConnectionStatus,
} from "@useagent/agent-client/provider-connections";
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type {
  ProviderConnectionAuthMethod,
  ProviderConnectionMetadata,
  ProviderConnectionProvider,
  ProviderConnectionStatus,
};
export {
  PROVIDER_CONNECTION_AUTH_METHODS,
  PROVIDER_CONNECTION_PROVIDERS,
  PROVIDER_CONNECTION_STATUSES,
};

// ---------------------------------------------------------------------------
// Provider connections — per-user, per-organization credentials for model and
// explicitly supported infrastructure providers. These are NOT sandbox secrets: plaintext is write-only at the HTTP
// boundary and decrypted only by trusted backend callers. Metadata is limited to
// safe display fields; credential material is AES-256-GCM sealed with the shared
// secrets crypto implementation.
// ---------------------------------------------------------------------------

export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    provider: text("provider").$type<ProviderConnectionProvider>().notNull(),
    authMethod: text("auth_method").$type<ProviderConnectionAuthMethod>().notNull(),
    status: text("status").$type<ProviderConnectionStatus>().notNull(),
    metadata: jsonb("metadata")
      .$type<ProviderConnectionMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    credentialCiphertext: text("credential_ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_provider_connections_org_user").on(t.orgId, t.userId),
    uniqueIndex("uq_provider_connections_scope").on(
      t.orgId,
      t.userId,
      t.provider,
      t.authMethod,
    ),
  ],
);

// Codex provider thread ids are subscription-account capabilities. Keep their
// ownership on the trusted host rather than accepting a resume cursor supplied
// by the sandbox. The auth epoch is part of the key so reconnecting an account
// cannot inherit thread access from the credential generation it replaced.
export const providerConnectionThreads = pgTable(
  "provider_connection_threads",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    productThreadId: text("product_thread_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    authEpoch: text("auth_epoch").notNull(),
    providerThreadId: text("provider_thread_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.orgId, t.userId, t.productThreadId, t.connectionId, t.authEpoch],
    }),
    uniqueIndex("uq_provider_connection_threads_provider_scope").on(
      t.connectionId,
      t.authEpoch,
      t.providerThreadId,
    ),
  ],
);
