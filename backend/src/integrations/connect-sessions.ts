import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { db } from "../db/client";
import {
  integrationConnections,
  integrationConnectSessions,
  slackUsers,
  slackWorkspaces,
} from "../db/schema";
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
import { upsertIntegrationCredential } from "./credential-repo";

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
  readonly state?: string;
}

export interface CreatedIntegrationConnectSession {
  readonly id: string;
  readonly state: string;
  readonly returnTo: string;
  readonly expiresAt: Date;
}

export interface ClaimedIntegrationConnectSession {
  readonly claimToken: string;
  readonly session: IntegrationConnectSessionRecord;
}

const CONNECT_PROCESSING_LEASE_MS = 60_000;

export function hashIntegrationConnectState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export function createIntegrationConnectState(): string {
  return randomBytes(32).toString("base64url");
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
  const state = input.state?.trim() || createIntegrationConnectState();
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

export async function claimIntegrationConnectSession(input: {
  readonly state: string;
  readonly orgId?: string;
  readonly actorUserId?: string;
  readonly now?: Date;
}): Promise<ClaimedIntegrationConnectSession | null> {
  if (!input.state) throw new Error("state is required");
  const now = input.now ?? new Date();
  const claimToken = randomUUID();
  const [session] = await db
    .update(integrationConnectSessions)
    .set({
      processingToken: claimToken,
      processingExpiresAt: new Date(now.getTime() + CONNECT_PROCESSING_LEASE_MS),
    })
    .where(
      and(
        eq(integrationConnectSessions.stateHash, hashIntegrationConnectState(input.state)),
        input.orgId ? eq(integrationConnectSessions.orgId, input.orgId) : undefined,
        input.actorUserId
          ? eq(integrationConnectSessions.actorUserId, input.actorUserId)
          : undefined,
        isNull(integrationConnectSessions.consumedAt),
        gt(integrationConnectSessions.expiresAt, now),
        or(
          isNull(integrationConnectSessions.processingToken),
          isNull(integrationConnectSessions.processingExpiresAt),
          lte(integrationConnectSessions.processingExpiresAt, now),
        ),
      ),
    )
    .returning();
  return session ? { claimToken, session } : null;
}

export async function releaseIntegrationConnectSessionClaim(input: {
  readonly sessionId: string;
  readonly claimToken: string;
}): Promise<void> {
  await db
    .update(integrationConnectSessions)
    .set({ processingToken: null, processingExpiresAt: null })
    .where(
      and(
        eq(integrationConnectSessions.id, input.sessionId),
        eq(integrationConnectSessions.processingToken, input.claimToken),
        isNull(integrationConnectSessions.consumedAt),
      ),
    );
}

/** Atomically claims one OAuth state and persists its safe connection projection. */
export async function finalizeIntegrationConnectSession(input: {
  readonly orgId: string;
  readonly actorUserId: string;
  readonly state: string;
  readonly claimToken?: string;
  readonly result: DelegatedConnectionResult;
  readonly now?: Date;
}): Promise<ConnectionProjection | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [session] = await tx
      .update(integrationConnectSessions)
      .set({ consumedAt: now, processingToken: null, processingExpiresAt: null })
      .where(
        and(
          eq(integrationConnectSessions.orgId, input.orgId),
          eq(integrationConnectSessions.actorUserId, input.actorUserId),
          eq(integrationConnectSessions.stateHash, hashIntegrationConnectState(input.state)),
          input.claimToken
            ? eq(integrationConnectSessions.processingToken, input.claimToken)
            : undefined,
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
    const values = {
        orgId: session.orgId,
        ...owner,
        provider: session.provider,
        runtimeBindingId: input.result.runtimeBindingId,
        externalConnectionId: input.result.externalConnectionId,
        externalConnectionName: input.result.externalConnectionName?.trim() || null,
        status: "connected" as const,
        authMethod: input.result.authMethod,
        accountMetadata: readSafeIntegrationAccount(input.result.account),
        scopes: readSafeIntegrationScopes(input.result.scopes),
        createdByUserId: session.actorUserId,
        lastVerifiedAt: now,
      };
    const [existing] = await tx
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.runtimeBindingId, input.result.runtimeBindingId),
          eq(integrationConnections.provider, session.provider),
          eq(integrationConnections.externalConnectionId, input.result.externalConnectionId),
        ),
      )
      .limit(1);
    if (
      existing &&
      (existing.orgId !== session.orgId ||
        existing.ownerType !== owner.ownerType ||
        existing.ownerUserId !== owner.ownerUserId)
    ) {
      throw new Error("integration connection belongs to a different owner");
    }
    const [connection] = existing
      ? await tx
          .update(integrationConnections)
          .set({
            externalConnectionName: values.externalConnectionName,
            status: "connected",
            authMethod: values.authMethod,
            accountMetadata: values.accountMetadata,
            scopes: values.scopes,
            lastVerifiedAt: now,
            revokedAt: null,
            updatedAt: now,
          })
          .where(eq(integrationConnections.id, existing.id))
          .returning()
      : await tx.insert(integrationConnections).values(values).returning();
    if (!connection) throw new Error("integration connection insert returned no row");
    if (input.result.credential) {
      await upsertIntegrationCredential(
        {
          connectionId: connection.id,
          orgId: connection.orgId,
          provider: connection.provider,
          externalConnectionId: connection.externalConnectionId,
        },
        input.result.credential,
        tx,
      );
    }
    if (session.provider === "slack" && input.result.workspaceBinding) {
      const binding = input.result.workspaceBinding;
      if (binding.externalWorkspaceId !== connection.externalConnectionId) {
        throw new Error("Slack workspace binding does not match the connection");
      }
      await tx
        .insert(slackWorkspaces)
        .values({
          teamId: binding.externalWorkspaceId,
          orgId: session.orgId,
          userId: session.actorUserId,
        })
        .onConflictDoUpdate({
          target: slackWorkspaces.teamId,
          set: { orgId: session.orgId, userId: session.actorUserId },
        });
      if (binding.externalActorId) {
        await tx
          .insert(slackUsers)
          .values({
            teamId: binding.externalWorkspaceId,
            slackUserId: binding.externalActorId,
            orgId: session.orgId,
            userId: session.actorUserId,
          })
          .onConflictDoUpdate({
            target: [slackUsers.teamId, slackUsers.slackUserId],
            set: { orgId: session.orgId, userId: session.actorUserId },
          });
      }
    }
    return projectIntegrationConnection(connection);
  });
}
