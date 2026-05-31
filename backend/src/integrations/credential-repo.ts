import { and, eq } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { integrationConnectionCredentials, integrationConnections } from "../db/schema";
import { openSecret, sealSecret } from "../secrets/crypto";

const MAX_FORMAT_LENGTH = 128;
const MAX_SERIALIZED_LENGTH = 64 * 1024;

export interface IntegrationCredentialIdentity {
  readonly connectionId: string;
  readonly orgId: string;
  readonly provider: string;
  readonly externalConnectionId: string;
}

export interface IntegrationCredentialMaterial {
  readonly format: string;
  readonly serialized: string;
}

function required(value: string, name: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

export async function upsertIntegrationCredential(
  identity: IntegrationCredentialIdentity,
  material: IntegrationCredentialMaterial,
  exec: Executor = db,
): Promise<void> {
  const format = required(material.format, "integration credential format", MAX_FORMAT_LENGTH);
  const serialized = required(
    material.serialized,
    "integration credential payload",
    MAX_SERIALIZED_LENGTH,
  );
  const [connection] = await exec
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, identity.connectionId),
        eq(integrationConnections.orgId, identity.orgId),
        eq(integrationConnections.provider, identity.provider),
        eq(integrationConnections.externalConnectionId, identity.externalConnectionId),
      ),
    )
    .limit(1);
  if (!connection) throw new Error("integration connection identity mismatch");
  const sealed = sealSecret(serialized);
  await exec
    .insert(integrationConnectionCredentials)
    .values({
      connectionId: identity.connectionId,
      orgId: identity.orgId,
      provider: identity.provider,
      externalConnectionId: identity.externalConnectionId,
      format,
      credentialCiphertext: sealed.ciphertext,
      iv: sealed.iv,
      tag: sealed.tag,
    })
    .onConflictDoUpdate({
      target: integrationConnectionCredentials.connectionId,
      set: {
        orgId: identity.orgId,
        provider: identity.provider,
        externalConnectionId: identity.externalConnectionId,
        format,
        credentialCiphertext: sealed.ciphertext,
        iv: sealed.iv,
        tag: sealed.tag,
        updatedAt: new Date(),
      },
    });
}

export async function readIntegrationCredential(
  identity: IntegrationCredentialIdentity,
  exec: Executor = db,
): Promise<IntegrationCredentialMaterial | null> {
  const [row] = await exec
    .select()
    .from(integrationConnectionCredentials)
    .where(
      and(
        eq(integrationConnectionCredentials.connectionId, identity.connectionId),
        eq(integrationConnectionCredentials.orgId, identity.orgId),
        eq(integrationConnectionCredentials.provider, identity.provider),
        eq(
          integrationConnectionCredentials.externalConnectionId,
          identity.externalConnectionId,
        ),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    format: row.format,
    serialized: openSecret({
      ciphertext: row.credentialCiphertext,
      iv: row.iv,
      tag: row.tag,
    }),
  };
}

export async function deleteIntegrationCredential(
  connectionId: string,
  exec: Executor = db,
): Promise<void> {
  await exec
    .delete(integrationConnectionCredentials)
    .where(eq(integrationConnectionCredentials.connectionId, connectionId));
}
