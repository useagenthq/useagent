import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { webhookEndpoints } from "../db/schema";
import { sealSecret } from "../secrets/crypto";

export interface WebhookEndpointMeta {
  readonly id: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toMeta(row: typeof webhookEndpoints.$inferSelect): WebhookEndpointMeta {
  return {
    id: row.id,
    url: row.url,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createWebhookEndpoint(
  orgId: string,
  url: string,
): Promise<{ endpoint: WebhookEndpointMeta; secret: string }> {
  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  const sealed = sealSecret(secret);
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      orgId,
      url,
      secretCiphertext: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
    })
    .returning();
  if (!row) throw new Error("webhook endpoint insert returned no row");
  return { endpoint: toMeta(row), secret };
}

export async function listWebhookEndpoints(orgId: string): Promise<WebhookEndpointMeta[]> {
  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.orgId, orgId), isNull(webhookEndpoints.disabledAt)))
    .orderBy(webhookEndpoints.createdAt);
  return rows.map(toMeta);
}

export async function disableWebhookEndpoint(orgId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(webhookEndpoints)
    .set({
      disabledAt: new Date(),
      secretCiphertext: null,
      secretIv: null,
      secretTag: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(webhookEndpoints.id, id),
        eq(webhookEndpoints.orgId, orgId),
        isNull(webhookEndpoints.disabledAt),
      ),
    )
    .returning({ id: webhookEndpoints.id });
  return rows.length > 0;
}
