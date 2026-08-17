import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import {
  providerConnections,
  providerConnectionThreads,
  type ProviderConnectionAuthMethod,
  type ProviderConnectionMetadata,
  type ProviderConnectionProvider,
  type ProviderConnectionStatus,
} from "../db/schema";

export type ProviderConnectionRecord = typeof providerConnections.$inferSelect;

export interface ProviderConnectionScope {
  orgId: string;
  userId: string;
}

export interface ProviderThreadBindingScope extends ProviderConnectionScope {
  productThreadId: string;
  connectionId: string;
  authEpoch: string;
}

export interface UpsertProviderConnectionInput extends ProviderConnectionScope {
  provider: ProviderConnectionProvider;
  authMethod: ProviderConnectionAuthMethod;
  status: ProviderConnectionStatus;
  metadata: ProviderConnectionMetadata;
  credentialCiphertext: string;
  iv: string;
  tag: string;
}

async function writeProviderConnection(
  input: UpsertProviderConnectionInput,
  preserveRevoked: boolean,
): Promise<ProviderConnectionRecord | null> {
  const now = new Date();
  const [row] = await db
    .insert(providerConnections)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      provider: input.provider,
      authMethod: input.authMethod,
      status: input.status,
      metadata: input.metadata,
      credentialCiphertext: input.credentialCiphertext,
      iv: input.iv,
      tag: input.tag,
      revokedAt: input.status === "revoked" ? now : null,
    })
    .onConflictDoUpdate({
      target: [
        providerConnections.orgId,
        providerConnections.userId,
        providerConnections.provider,
        providerConnections.authMethod,
      ],
      set: {
        status: input.status,
        metadata: input.metadata,
        credentialCiphertext: input.credentialCiphertext,
        iv: input.iv,
        tag: input.tag,
        revokedAt: input.status === "revoked" ? now : null,
        updatedAt: now,
      },
      ...(preserveRevoked ? { setWhere: eq(providerConnections.status, "connected") } : {}),
    })
    .returning();
  return row ?? null;
}

export async function listProviderConnections(
  scope: ProviderConnectionScope,
): Promise<ProviderConnectionRecord[]> {
  return db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.orgId, scope.orgId),
        eq(providerConnections.userId, scope.userId),
      ),
    )
    .orderBy(asc(providerConnections.provider), asc(providerConnections.authMethod));
}

export async function findProviderConnection(
  scope: ProviderConnectionScope & {
    provider: ProviderConnectionProvider;
    authMethod?: ProviderConnectionAuthMethod;
  },
): Promise<ProviderConnectionRecord | null> {
  const filters = [
    eq(providerConnections.orgId, scope.orgId),
    eq(providerConnections.userId, scope.userId),
    eq(providerConnections.provider, scope.provider),
  ];
  if (scope.authMethod) filters.push(eq(providerConnections.authMethod, scope.authMethod));
  const [row] = await db
    .select()
    .from(providerConnections)
    .where(and(...filters))
    .orderBy(asc(providerConnections.authMethod))
    .limit(1);
  return row ?? null;
}

export async function upsertProviderConnection(
  input: UpsertProviderConnectionInput,
): Promise<ProviderConnectionRecord> {
  const row = await writeProviderConnection(input, false);
  if (!row) throw new Error("provider connection upsert returned no row");
  return row;
}

export async function upsertProviderConnectionUnlessRevoked(
  input: UpsertProviderConnectionInput,
): Promise<ProviderConnectionRecord | null> {
  return writeProviderConnection(input, true);
}

export async function revokeProviderConnection(
  scope: ProviderConnectionScope & {
    provider: ProviderConnectionProvider;
    authMethod?: ProviderConnectionAuthMethod;
  },
): Promise<ProviderConnectionRecord | null> {
  const filters = [
    eq(providerConnections.orgId, scope.orgId),
    eq(providerConnections.userId, scope.userId),
    eq(providerConnections.provider, scope.provider),
  ];
  if (scope.authMethod) filters.push(eq(providerConnections.authMethod, scope.authMethod));
  const [row] = await db
    .update(providerConnections)
    .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
    .where(and(...filters))
    .returning();
  return row ?? null;
}

export async function findProviderThreadBinding(
  scope: ProviderThreadBindingScope,
): Promise<string | null> {
  const [row] = await db
    .select({ providerThreadId: providerConnectionThreads.providerThreadId })
    .from(providerConnectionThreads)
    .where(
      and(
        eq(providerConnectionThreads.orgId, scope.orgId),
        eq(providerConnectionThreads.userId, scope.userId),
        eq(providerConnectionThreads.productThreadId, scope.productThreadId),
        eq(providerConnectionThreads.connectionId, scope.connectionId),
        eq(providerConnectionThreads.authEpoch, scope.authEpoch),
      ),
    )
    .limit(1);
  return row?.providerThreadId ?? null;
}

export async function bindProviderThread(
  scope: ProviderThreadBindingScope & { providerThreadId: string },
): Promise<void> {
  await db
    .insert(providerConnectionThreads)
    .values({
      orgId: scope.orgId,
      userId: scope.userId,
      productThreadId: scope.productThreadId,
      connectionId: scope.connectionId,
      authEpoch: scope.authEpoch,
      providerThreadId: scope.providerThreadId,
    })
    .onConflictDoNothing();

  const established = await findProviderThreadBinding(scope);
  if (established !== scope.providerThreadId) {
    throw new Error("Codex provider thread binding already exists");
  }
}
