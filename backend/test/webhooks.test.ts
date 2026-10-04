import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { artifacts, runs, webhookDeliveryOutbox, webhookEndpoints } from "../src/db/schema";
import { env } from "../src/env";
import { finalizeRun } from "../src/runs/finalize";
import { createRun } from "../src/runs/repo";
import { processDueWebhooks, type WebhookRequest } from "../src/webhooks/delivery";
import { verifyWebhookSignature } from "../src/webhooks/signature";
import { createOrgSession, json, type OrgSession } from "./helpers";
import "./helpers";

interface CreatedWebhook {
  readonly endpoint: { readonly id: string; readonly url: string };
  readonly secret: string;
}

const testOrgIds = new Set<string>();

async function createWebhook(org: OrgSession, url = "https://hooks.example.org/events"): Promise<CreatedWebhook> {
  const result = await json<CreatedWebhook>("/api/webhooks", {
    method: "POST",
    cookies: org.cookies,
    body: { url },
  });
  expect(result.status).toBe(201);
  return result.body;
}

async function createWebhookRun(orgId: string, origin: string | null = null): Promise<string> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "Prepare the report",
    model: "claude-opus-5",
    engine: "mock",
    orgId,
    userId: null,
    parentRunId: null,
    threadId: runId,
    origin,
  });
  return runId;
}

afterEach(async () => {
  for (const orgId of testOrgIds) {
    await db.delete(webhookDeliveryOutbox).where(eq(webhookDeliveryOutbox.orgId, orgId));
    await db.delete(webhookEndpoints).where(eq(webhookEndpoints.orgId, orgId));
    await db.delete(runs).where(eq(runs.orgId, orgId));
  }
  testOrgIds.clear();
});

describe("webhook endpoints", () => {
  test("generates a one-time secret, encrypts it at rest, and rejects unsafe URLs", async () => {
    const org = await createOrgSession("webhook-create");
    testOrgIds.add(org.orgId);

    expect((await json("/api/webhooks", {
      method: "POST",
      cookies: org.cookies,
      body: { url: "http://hooks.example.org/events" },
    })).status).toBe(400);
    expect((await json("/api/webhooks", {
      method: "POST",
      cookies: org.cookies,
      body: { url: "https://127.0.0.1/events" },
    })).status).toBe(400);

    const created = await createWebhook(org);
    expect(created.secret.startsWith("whsec_")).toBe(true);

    const [row] = await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, created.endpoint.id));
    expect(row?.secretCiphertext).toBeTruthy();
    expect(row?.secretCiphertext).not.toBe(created.secret);
    expect(JSON.stringify(row)).not.toContain(created.secret);

    const list = await json<{ webhooks: Array<Record<string, unknown>> }>("/api/webhooks", {
      cookies: org.cookies,
    });
    expect(list.status).toBe(200);
    expect(list.body.webhooks[0]).toEqual({
      id: created.endpoint.id,
      url: created.endpoint.url,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect((await json("/api/webhooks", {
      headers: { authorization: "Bearer uak_invalid" },
    })).status).toBe(401);
  });
});

describe("webhook finalization and delivery", () => {
  test("atomically queues completed and failed runs, then delivers signed payloads", async () => {
    const org = await createOrgSession("webhook-finalize");
    testOrgIds.add(org.orgId);
    const webhook = await createWebhook(org);
    const completedId = await createWebhookRun(org.orgId);
    const failedId = await createWebhookRun(org.orgId);
    const internalId = await createWebhookRun(org.orgId, "internal:release-parity");
    const [artifact] = await db.insert(artifacts).values({
      orgId: org.orgId,
      runId: completedId,
      threadId: completedId,
      sourcePath: "/work/report.pdf",
      name: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 12,
      sha256: "d".repeat(64),
      storageKey: `test/${completedId}/report.pdf`,
    }).returning({ id: artifacts.id });

    await finalizeRun(completedId, "completed", "Report is ready", 250);
    await finalizeRun(completedId, "failed", "Late finalizer", 1);
    await finalizeRun(failedId, "failed", "The report could not be generated", 250);
    await finalizeRun(internalId, "completed", "Internal probe", 10);

    const queued = await db
      .select()
      .from(webhookDeliveryOutbox)
      .where(eq(webhookDeliveryOutbox.orgId, org.orgId));
    expect(queued).toHaveLength(2);
    expect(queued.map((row) => row.event).sort()).toEqual(["run.completed", "run.failed"]);
    expect(queued.every((row) => row.state === "pending")).toBe(true);
    expect((await db.select().from(runs).where(eq(runs.id, completedId)))[0]?.status).toBe("completed");
    expect((await db.select().from(runs).where(eq(runs.id, failedId)))[0]?.status).toBe("failed");

    const sent: WebhookRequest[] = [];
    const result = await processDueWebhooks(20, async (request) => {
      sent.push(request);
      return true;
    });
    expect(result).toEqual({ delivered: 2, retried: 0, dead: 0 });
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.url).toBe(webhook.endpoint.url);
      expect(verifyWebhookSignature(webhook.secret, request.payload, request.signature)).toBe(true);
      const payload = JSON.parse(request.payload) as {
        event: string;
        data: {
          run_id: string;
          status: string;
          thread_url: string;
          artifacts: Array<{ id: string; name: string; url: string }>;
        };
      };
      expect(payload.event).toBe(`run.${payload.data.status}`);
      expect(payload.data.run_id).toBeTruthy();
      expect(payload.data.thread_url).toContain(`/session/${payload.data.run_id}`);
      if (payload.data.run_id === completedId) {
        expect(payload.data.artifacts).toEqual([{
          id: artifact!.id,
          name: "report.pdf",
          url: new URL(`/api/artifacts/${artifact!.id}/content?download=1`, env.FRONTEND_ORIGIN).toString(),
        }]);
      }
    }
  });

  test("retries delivery failures and cancels pending work when an endpoint is disabled", async () => {
    const org = await createOrgSession("webhook-retry");
    testOrgIds.add(org.orgId);
    const webhook = await createWebhook(org);
    const runId = await createWebhookRun(org.orgId);
    await finalizeRun(runId, "completed", "Ready", 100);

    const failure = await processDueWebhooks(20, async () => false);
    expect(failure).toEqual({ delivered: 0, retried: 1, dead: 0 });
    const [pending] = await db
      .select()
      .from(webhookDeliveryOutbox)
      .where(and(
        eq(webhookDeliveryOutbox.orgId, org.orgId),
        eq(webhookDeliveryOutbox.runId, runId),
      ));
    expect(pending?.state).toBe("pending");
    expect(pending?.attemptCount).toBe(1);
    expect(pending?.lastError).toBe("delivery failed");

    const disabled = await json(`/api/webhooks/${webhook.endpoint.id}`, {
      method: "DELETE",
      cookies: org.cookies,
    });
    expect(disabled.status).toBe(200);
    await db
      .update(webhookDeliveryOutbox)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(webhookDeliveryOutbox.id, pending!.id));

    let senderCalled = false;
    const cancelled = await processDueWebhooks(20, async () => {
      senderCalled = true;
      return true;
    });
    expect(cancelled).toEqual({ delivered: 0, retried: 0, dead: 1 });
    expect(senderCalled).toBe(false);
    const [dead] = await db
      .select()
      .from(webhookDeliveryOutbox)
      .where(eq(webhookDeliveryOutbox.id, pending!.id));
    expect(dead?.state).toBe("dead");
  });
});
