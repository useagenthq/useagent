import { request as httpsRequest } from "node:https";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import {
  backoffAt as computeBackoff,
  claimDue as claimDueRows,
  markDead,
  markForRetry,
  markSuccess,
  outboxOutcome,
  resetStuck,
  type BackoffPolicy,
  type OutboxTable,
} from "../db/outbox";
import { webhookDeliveryOutbox, webhookEndpoints } from "../db/schema";
import { openSecret } from "../secrets/crypto";
import { signWebhookPayload } from "./signature";
import { resolveWebhookDestination } from "./url";

const WEBHOOK_POLICY: BackoffPolicy = { baseMs: 30_000, maxMs: 3_600_000 };
const WEBHOOK_OUTBOX: OutboxTable = {
  table: "webhook_delivery_outbox",
  key: "id",
  stateColumn: "state",
  attemptColumn: "attempt_count",
  pending: "pending",
  claimed: "delivering",
  dead: "dead",
};

interface ClaimedWebhook {
  readonly id: string;
  readonly orgId: string;
  readonly endpointId: string;
  readonly payload: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
}

export interface WebhookRequest {
  readonly url: string;
  readonly payload: string;
  readonly signature: string;
  readonly deliveryId: string;
}

export type WebhookSender = (input: WebhookRequest) => Promise<boolean>;

export function webhookBackoffAt(now: number, attempt: number): Date {
  return computeBackoff(WEBHOOK_POLICY, now, attempt);
}

async function sendWebhook(input: WebhookRequest): Promise<boolean> {
  let destination;
  try {
    destination = await resolveWebhookDestination(input.url);
  } catch {
    return false;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const request = httpsRequest(
      destination.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(input.payload, "utf8")),
          "user-agent": "UseAgent-Webhooks/1.0",
          "x-useagent-delivery": input.deliveryId,
          "x-useagent-signature": input.signature,
        },
        servername: destination.url.hostname,
        signal: AbortSignal.timeout(10_000),
        lookup: (_hostname, _options, callback) => {
          callback(null, destination.address, destination.family);
        },
      },
      (response) => {
        response.resume();
        finish(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300);
      },
    );
    request.once("error", () => finish(false));
    request.end(input.payload);
  });
}

async function claimDue(limit: number): Promise<ClaimedWebhook[]> {
  const rows = await claimDueRows(WEBHOOK_OUTBOX, limit, ["org_id", "endpoint_id", "payload"]);
  return rows.map((row) => ({
    id: row.id as string,
    orgId: row.org_id as string,
    endpointId: row.endpoint_id as string,
    payload: row.payload as string,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
  }));
}

export async function processDueWebhooks(
  limit = 20,
  send: WebhookSender = sendWebhook,
): Promise<{ delivered: number; retried: number; dead: number }> {
  const rows = await claimDue(limit);
  let delivered = 0;
  let retried = 0;
  let dead = 0;

  for (const row of rows) {
    const [endpoint] = await db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, row.endpointId),
          eq(webhookEndpoints.orgId, row.orgId),
          isNull(webhookEndpoints.disabledAt),
        ),
      )
      .limit(1);
    if (!endpoint?.secretCiphertext || !endpoint.secretIv || !endpoint.secretTag) {
      await markDead(WEBHOOK_OUTBOX, row.id, "endpoint disabled or signing secret unavailable");
      dead++;
      continue;
    }

    let ok = false;
    try {
      const secret = openSecret({
        ciphertext: endpoint.secretCiphertext,
        iv: endpoint.secretIv,
        tag: endpoint.secretTag,
      });
      ok = await send({
        url: endpoint.url,
        payload: row.payload,
        signature: signWebhookPayload(secret, row.payload),
        deliveryId: row.id,
      });
    } catch {
      ok = false;
    }

    const outcome = outboxOutcome(ok, row.attemptCount, row.maxAttempts);
    if (outcome === "success") {
      await markSuccess(WEBHOOK_OUTBOX, row.id, "delivered");
      delivered++;
    } else if (outcome === "dead") {
      await markDead(WEBHOOK_OUTBOX, row.id, "delivery failed after max attempts");
      dead++;
    } else {
      await markForRetry(
        WEBHOOK_OUTBOX,
        row.id,
        webhookBackoffAt(Date.now(), row.attemptCount + 1),
        "delivery failed",
      );
      retried++;
    }
  }

  return { delivered, retried, dead };
}

export function resetStuckWebhooks(): Promise<number> {
  return resetStuck(WEBHOOK_OUTBOX);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startWebhookDelivery(intervalMs = Number(process.env.WEBHOOK_OUTBOX_TICK_MS ?? 15_000)): void {
  if (timer) return;
  timer = setInterval(() => {
    void processDueWebhooks().catch((error) => console.error("[webhooks] delivery tick failed:", error));
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}
