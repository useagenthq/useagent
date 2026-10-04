import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Executor } from "../db/client";
import {
  artifacts,
  runs,
  webhookDeliveryOutbox,
  webhookEndpoints,
  type RunStatus,
} from "../db/schema";
import { isInternalRunOrigin } from "../runs/origin";
import { sessionUrl } from "../slack/card";

const MAX_PAYLOAD_BYTES = 48_000;
const MAX_ARTIFACTS = 25;
const MAX_ARTIFACT_NAME = 160;

export function buildRunWebhookPayload(input: {
  readonly id: string;
  readonly event: string;
  readonly createdAt: string;
  readonly runId: string;
  readonly threadId: string;
  readonly status: Extract<RunStatus, "completed" | "failed">;
  readonly summary: string;
  readonly threadUrl: string;
  readonly frontendOrigin: string;
  readonly artifacts: readonly { readonly id: string; readonly name: string }[];
}): string {
  const selectedArtifacts = input.artifacts.slice(0, MAX_ARTIFACTS).map((artifact) => ({
    id: artifact.id,
    name: artifact.name.slice(0, MAX_ARTIFACT_NAME),
    url: new URL(
      `/api/artifacts/${encodeURIComponent(artifact.id)}/content?download=1`,
      input.frontendOrigin,
    ).toString(),
  }));
  let summaryLength = input.summary.length;

  while (true) {
    const data = {
      run_id: input.runId,
      thread_id: input.threadId,
      status: input.status,
      summary: input.summary.slice(0, summaryLength),
      summary_truncated: summaryLength < input.summary.length,
      thread_url: input.threadUrl,
      artifacts: selectedArtifacts,
      artifacts_truncated: selectedArtifacts.length < input.artifacts.length,
    };
    const payload = JSON.stringify({
      id: input.id,
      event: input.event,
      created_at: input.createdAt,
      data,
    });
    if (Buffer.byteLength(payload, "utf8") <= MAX_PAYLOAD_BYTES) return payload;
    if (summaryLength > 0) {
      summaryLength = Math.floor(summaryLength * 0.75);
    } else if (selectedArtifacts.length > 0) {
      selectedArtifacts.pop();
    } else {
      throw new Error("webhook payload exceeds the delivery limit");
    }
  }
}

export async function enqueueRunWebhookDeliveries(
  exec: Executor,
  run: typeof runs.$inferSelect,
  status: Extract<RunStatus, "completed" | "failed">,
  summary: string,
  frontendOrigin: string,
): Promise<void> {
  if (!run.orgId || isInternalRunOrigin(run.origin)) return;

  const endpoints = await exec
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.orgId, run.orgId), isNull(webhookEndpoints.disabledAt)));
  if (endpoints.length === 0) return;

  const runArtifacts = await exec
    .select({ id: artifacts.id, name: artifacts.name })
    .from(artifacts)
    .where(and(eq(artifacts.orgId, run.orgId), eq(artifacts.runId, run.id)))
    .orderBy(desc(artifacts.createdAt))
    .limit(MAX_ARTIFACTS + 1);

  const event = `run.${status}`;
  const payload = buildRunWebhookPayload({
    id: randomUUID(),
    event,
    createdAt: new Date().toISOString(),
    runId: run.id,
    threadId: run.threadId,
    status,
    summary,
    threadUrl: sessionUrl(frontendOrigin, run.threadId),
    frontendOrigin,
    artifacts: runArtifacts,
  });

  for (const endpoint of endpoints) {
    await exec
      .insert(webhookDeliveryOutbox)
      .values({ orgId: run.orgId, endpointId: endpoint.id, runId: run.id, event, payload })
      .onConflictDoNothing({
        target: [webhookDeliveryOutbox.endpointId, webhookDeliveryOutbox.runId],
      });
  }
}
