import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db } from "../db/client";
import {
  integrationConnections,
  type IntegrationConnectionAuthMethod,
  type IntegrationConnectionStatus,
} from "../db/schema";
import {
  ownerColumns,
  readSafeIntegrationAccount,
  readSafeIntegrationScopes,
  requireNonEmptyIntegrationIdentifier,
  type ConnectionOwner,
  type ConnectionProjection,
  type IntegrationConnectionScope,
} from "./types";

export type IntegrationConnectionRecord = typeof integrationConnections.$inferSelect;

export interface CreateIntegrationConnectionInput extends IntegrationConnectionScope {
  readonly provider: string;
  readonly runtimeBindingId: string;
  readonly externalConnectionId: string;
  readonly externalConnectionName?: string | null;
  readonly status: IntegrationConnectionStatus;
  readonly authMethod: IntegrationConnectionAuthMethod;
  readonly account: unknown;
  readonly scopes: unknown;
  readonly createdByUserId: string;
  readonly lastVerifiedAt?: Date | null;
}

export interface UpdateIntegrationConnectionInput extends IntegrationConnectionScope {
  readonly id: string;
  readonly status: IntegrationConnectionStatus;
  readonly account: unknown;
  readonly scopes: unknown;
  readonly externalConnectionName?: string | null;
  readonly lastVerifiedAt?: Date | null;
}

function ownerPredicate(orgId: string, owner: ConnectionOwner) {
  const columns = ownerColumns(owner);
  return and(
    eq(integrationConnections.orgId, orgId),
    eq(integrationConnections.ownerType, columns.ownerType),
    columns.ownerUserId === null
      ? isNull(integrationConnections.ownerUserId)
      : eq(integrationConnections.ownerUserId, columns.ownerUserId),
  );
}

function visiblePredicate(orgId: string, userId: string) {
  return and(
    eq(integrationConnections.orgId, orgId),
    or(
      and(
        eq(integrationConnections.ownerType, "org"),
        isNull(integrationConnections.ownerUserId),
      ),
      and(
        eq(integrationConnections.ownerType, "user"),
        eq(integrationConnections.ownerUserId, userId),
      ),
    ),
  );
}

function toProjection(row: IntegrationConnectionRecord): ConnectionProjection {
  return {
    id: row.id,
    provider: row.provider,
    owner: row.ownerType === "org"
      ? { type: "org" }
      : { type: "user", userId: row.ownerUserId! },
    status: row.status,
    account: readSafeIntegrationAccount(row.accountMetadata),
    scopes: readSafeIntegrationScopes(row.scopes),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function createIntegrationConnection(
  input: CreateIntegrationConnectionInput,
): Promise<ConnectionProjection> {
  const owner = ownerColumns(input.owner);
  const status = input.status;
  const [row] = await db
    .insert(integrationConnections)
    .values({
      orgId: requireNonEmptyIntegrationIdentifier(input.orgId, "orgId"),
      ...owner,
      provider: requireNonEmptyIntegrationIdentifier(input.provider, "provider"),
      runtimeBindingId: requireNonEmptyIntegrationIdentifier(
        input.runtimeBindingId,
        "runtimeBindingId",
      ),
      externalConnectionId: requireNonEmptyIntegrationIdentifier(
        input.externalConnectionId,
        "externalConnectionId",
      ),
      externalConnectionName: input.externalConnectionName?.trim() || null,
      status,
      authMethod: input.authMethod,
      accountMetadata: readSafeIntegrationAccount(input.account),
      scopes: readSafeIntegrationScopes(input.scopes),
      createdByUserId: requireNonEmptyIntegrationIdentifier(
        input.createdByUserId,
        "createdByUserId",
      ),
      lastVerifiedAt: input.lastVerifiedAt ?? null,
      revokedAt: status === "revoked" ? new Date() : null,
    })
    .returning();
  if (!row) throw new Error("integration connection insert returned no row");
  return toProjection(row);
}

export async function listVisibleIntegrationConnections(scope: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<ConnectionProjection[]> {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(visiblePredicate(scope.orgId, scope.userId))
    .orderBy(asc(integrationConnections.provider), asc(integrationConnections.createdAt));
  return rows.map(toProjection);
}

export async function findVisibleIntegrationConnection(scope: {
  readonly orgId: string;
  readonly userId: string;
  readonly id: string;
}): Promise<ConnectionProjection | null> {
  const [row] = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        visiblePredicate(scope.orgId, scope.userId),
        eq(integrationConnections.id, scope.id),
      ),
    )
    .limit(1);
  return row ? toProjection(row) : null;
}

export async function updateOwnedIntegrationConnection(
  input: UpdateIntegrationConnectionInput,
): Promise<ConnectionProjection | null> {
  const now = new Date();
  const [row] = await db
    .update(integrationConnections)
    .set({
      status: input.status,
      accountMetadata: readSafeIntegrationAccount(input.account),
      scopes: readSafeIntegrationScopes(input.scopes),
      externalConnectionName: input.externalConnectionName?.trim() || null,
      lastVerifiedAt: input.lastVerifiedAt ?? null,
      revokedAt: input.status === "revoked" ? now : null,
      updatedAt: now,
    })
    .where(
      and(
        ownerPredicate(input.orgId, input.owner),
        eq(integrationConnections.id, input.id),
      ),
    )
    .returning();
  return row ? toProjection(row) : null;
}
