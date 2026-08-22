import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { integrationConnections, integrationConnectSessions } from "../db/schema";
import { projectIntegrationConnection } from "./connection-repo";
import {
  ownerColumns,
  readSafeIntegrationAccount,
  readSafeIntegrationScopes,
  requireNonEmptyIntegrationIdentifier,
  type ConnectionOwner,
  type ConnectionProjection,
} from "./types";
import type { DelegatedConnectionResult } from "./backend";

export type IntegrationConnectSessionRecord = typeof integrationConnectSessions.$inferSelect;

export interface CreateIntegrationConnectSessionInput {
  readonly orgId: string;
  readonly actorUserId: string;
  readonly owner: ConnectionOwner;
  readonly provider: string;
  readonly runtimeBindingId: string;
  readonly backendSessionRef: string;
  readonly returnTo: string;
  readonly expiresAt: Date;
}

export interface CreatedIntegrationConnectSession {
  readonly id: string;
  readonly state: string;
  readonly returnTo: string;
  readonly expiresAt: Date;
}

export function hashIntegrationConnectState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export function normalizeIntegrationReturnTo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const returnTo = value.trim();
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.includes("\\")) {
    return null;
  }
  try {
    const base = new URL("https://useagent.invalid");
    const parsed = new URL(returnTo, base);
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (
      parsed.origin !== base.origin ||
      decodedPath.startsWith("//") ||
      decodedPath.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(decodedPath)
    ) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export async function createIntegrationConnectSession(
  input: CreateIntegrationConnectSessionInput,
): Promise<CreatedIntegrationConnectSession> {
  const returnTo = normalizeIntegrationReturnTo(input.returnTo);
  if (!returnTo) throw new Error("returnTo must be a same-origin relative path");
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
    throw new Error("expiresAt must be a valid date");
  }
  if (input.expiresAt.getTime() <= Date.now()) {
    throw new Error("expiresAt must be in the future");
  }
  const state = randomBytes(32).toString("base64url");
  const owner = ownerColumns(input.owner);
  const [row] = await db
    .insert(integrationConnectSessions)
    .values({
      orgId: requireNonEmptyIntegrationIdentifier(input.orgId, "orgId"),
      actorUserId: requireNonEmptyIntegrationIdentifier(input.actorUserId, "actorUserId"),
      ...owner,
      provider: requireNonEmptyIntegrationIdentifier(input.provider, "provider"),
      runtimeBindingId: requireNonEmptyIntegrationIdentifier(
        input.runtimeBindingId,
        "runtimeBindingId",
      ),
      backendSessionRef: requireNonEmptyIntegrationIdentifier(
        input.backendSessionRef,
        "backendSessionRef",
      ),
      stateHash: hashIntegrationConnectState(state),
      returnTo,
      expiresAt: input.expiresAt,
    })
    .returning({
      id: integrationConnectSessions.id,
      returnTo: integrationConnectSessions.returnTo,
      expiresAt: integrationConnectSessions.expiresAt,
    });
  if (!row) throw new Error("integration connect session insert returned no row");
  return { ...row, state };
}

export async function consumeIntegrationConnectSession(input: {
  readonly orgId: string;
  readonly actorUserId: string;
  readonly state: string;
  readonly now?: Date;
}): Promise<IntegrationConnectSessionRecord | null> {
  if (!input.state) throw new Error("state is required");
  const now = input.now ?? new Date();
  const [row] = await db
    .update(integrationConnectSessions)
    .set({ consumedAt: now })
    .where(
      and(
        eq(integrationConnectSessions.orgId, input.orgId),
        eq(integrationConnectSessions.actorUserId, input.actorUserId),
        eq(integrationConnectSessions.stateHash, hashIntegrationConnectState(input.state)),
        isNull(integrationConnectSessions.consumedAt),
        gt(integrationConnectSessions.expiresAt, now),
      ),
    )
    .returning();
  return row ?? null;
}

export async function findActiveIntegrationConnectSession(input: {
  readonly orgId: string;
  readonly actorUserId: string;
  readonly state: string;
  readonly now?: Date;
}): Promise<IntegrationConnectSessionRecord | null> {
  if (!input.state) throw new Error("state is required");
  const now = input.now ?? new Date();
  const [row] = await db
    .select()
    .from(integrationConnectSessions)
    .where(
      and(
        eq(integrationConnectSessions.orgId, input.orgId),
        eq(integrationConnectSessions.actorUserId, input.actorUserId),
        eq(integrationConnectSessions.stateHash, hashIntegrationConnectState(input.state)),
        isNull(integrationConnectSessions.consumedAt),
        gt(integrationConnectSessions.expiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Atomically claims one OAuth state and persists its safe connection projection. */
export async function finalizeIntegrationConnectSession(input: {
  readonly orgId: string;
  readonly actorUserId: string;
  readonly state: string;
  readonly result: DelegatedConnectionResult;
  readonly now?: Date;
}): Promise<ConnectionProjection | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [session] = await tx
      .update(integrationConnectSessions)
      .set({ consumedAt: now })
      .where(
        and(
          eq(integrationConnectSessions.orgId, input.orgId),
          eq(integrationConnectSessions.actorUserId, input.actorUserId),
          eq(integrationConnectSessions.stateHash, hashIntegrationConnectState(input.state)),
          isNull(integrationConnectSessions.consumedAt),
          gt(integrationConnectSessions.expiresAt, now),
        ),
      )
      .returning();
    if (!session) return null;
    const owner = ownerColumns(
      session.ownerType === "org"
        ? { type: "org" }
        : { type: "user", userId: session.ownerUserId! },
    );
    const [connection] = await tx
      .insert(integrationConnections)
      .values({
        orgId: session.orgId,
        ...owner,
        provider: session.provider,
        runtimeBindingId: input.result.runtimeBindingId,
        externalConnectionId: input.result.externalConnectionId,
        externalConnectionName: input.result.externalConnectionName?.trim() || null,
        status: "connected",
        authMethod: input.result.authMethod,
        accountMetadata: readSafeIntegrationAccount(input.result.account),
        scopes: readSafeIntegrationScopes(input.result.scopes),
        createdByUserId: session.actorUserId,
        lastVerifiedAt: now,
      })
      .returning();
    if (!connection) throw new Error("integration connection insert returned no row");
    return projectIntegrationConnection(connection);
  });
}
