import { Hono } from "hono";
import type { AppEnv } from "../http";
import {
  getPublicThreadRelationshipView,
  listOrgThreadRelationships,
  listThreadFamilyChildren,
  type ThreadRelationshipCursor,
  type ThreadRelationshipView,
} from "./thread-relationship-repo";
import { acceptThreadFollowup } from "./thread-followups";
import { productChildComposerEnabled, threadRelationshipReadEnabled } from "./thread-relationship-rollout";
import { pumpThread } from "../worker";
import { runQueueView } from "../fleet/view";
import { RunPromptTooLargeError } from "../commands/prompt-policy";
import { RunAdmissionClosedError } from "../commands/admission";
import { FleetQueueLimitError } from "../fleet/intake";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { agentExecutions, finishedWorkReceipts, runs } from "../db/schema";
import { createChildSession } from "./child-sessions";
import {
  CHILD_CONTEXT_MAX_BYTES,
  CHILD_CONTEXT_MAX_CHARS,
  CHILD_TRANSCRIPT_EVENT_LIMIT,
} from "./child-session-policy";
import { UploadClaimError } from "../uploads/repo";
import { loadCanonicalExecutionEvents } from "./canonical-events";
import { strictOrgSecretRedactor } from "../secrets/store";
import { listArtifactsForOrg } from "../artifacts/repo";

const CONTINUE_REFERENCE_LIMIT = 4;
const CONTINUE_RESULT_MAX_CHARS = 1_000;
const MAX_CURSOR_MICROSECONDS = 253_402_300_799_999_999n;

const routes = new Hono<AppEnv>();

function wire(view: ThreadRelationshipView) {
  return {
    thread_id: view.threadId,
    parent_thread_id: view.parentThreadId,
    family_thread_id: view.familyThreadId,
    kind: view.kind,
    title: view.title,
    source_run_id: view.sourceRunId,
    source_execution_id: view.sourceExecutionId,
    status: view.status,
    engine: view.engine,
    model: view.model,
    latest_run_id: view.latestRunId,
    latest_activity_at: view.latestActivityAt.toISOString(),
    created_at: view.createdAt.toISOString(),
    updated_at: view.updatedAt.toISOString(),
  };
}

function cursor(
  orgId: string,
  view: ThreadRelationshipCursor | undefined | null,
): string | null {
  if (!view) return null;
  return Buffer.from(JSON.stringify([orgId, view.createdAtMicros, view.threadId])).toString("base64url");
}

function parseCursor(orgId: string, value: string | undefined): ThreadRelationshipCursor | null | "invalid" {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== orgId || typeof decoded[1] !== "string" || typeof decoded[2] !== "string") return "invalid";
    if (!/^[0-9]{1,20}$/.test(decoded[1]) || !decoded[2]) return "invalid";
    const microseconds = BigInt(decoded[1]);
    if (microseconds > MAX_CURSOR_MICROSECONDS) return "invalid";
    return { createdAtMicros: decoded[1], threadId: decoded[2] };
  } catch {
    return "invalid";
  }
}

function limit(raw: string | undefined, fallback: number, max: number): number | null {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

routes.get("/relationships", async (c) => {
  if (!threadRelationshipReadEnabled(c.get("orgId"))) return c.json({ error: "not_found" }, 404);
  const pageLimit = limit(c.req.query("limit"), 100, 200);
  const after = parseCursor(c.get("orgId"), c.req.query("cursor"));
  if (pageLimit === null || after === "invalid") return c.json({ error: "invalid_pagination" }, 400);
  const page = await listOrgThreadRelationships({ orgId: c.get("orgId"), limit: pageLimit, after });
  return c.json({
    relationships: page.relationships.map(wire),
    has_more: page.hasMore,
    next_cursor: cursor(c.get("orgId"), page.next),
  });
});

routes.get("/:threadId/relationship", async (c) => {
  if (!threadRelationshipReadEnabled(c.get("orgId"))) return c.json({ error: "not_found" }, 404);
  const relationship = await getPublicThreadRelationshipView(c.get("orgId"), c.req.param("threadId"));
  return relationship ? c.json({ relationship: wire(relationship) }) : c.json({ error: "not_found" }, 404);
});

routes.get("/:familyThreadId/children", async (c) => {
  if (!threadRelationshipReadEnabled(c.get("orgId"))) return c.json({ error: "not_found" }, 404);
  const family = await getPublicThreadRelationshipView(c.get("orgId"), c.req.param("familyThreadId"));
  if (!family || family.familyThreadId !== family.threadId) return c.json({ error: "not_found" }, 404);
  const pageLimit = limit(c.req.query("limit"), 100, 100);
  const after = parseCursor(c.get("orgId"), c.req.query("cursor"));
  if (pageLimit === null || after === "invalid") return c.json({ error: "invalid_pagination" }, 400);
  const page = await listThreadFamilyChildren({
    orgId: c.get("orgId"),
    familyThreadId: family.threadId,
    limit: pageLimit,
    after,
  });
  return c.json({
    children: page.children.map(wire),
    has_more: page.hasMore,
    next_cursor: cursor(c.get("orgId"), page.next),
  });
});

routes.post("/:parentThreadId/continue-native-child", async (c) => {
  if (!productChildComposerEnabled(c.get("orgId"))) return c.json({ error: "not_found" }, 404);
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > 128 * 1024) return c.json({ error: "request_too_large" }, 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid_body" }, 400);
  const record = body as Record<string, unknown>;
  const executionId = typeof record.executionId === "string" ? record.executionId.trim() : "";
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const idempotencyKey = typeof record.idempotencyKey === "string"
    ? record.idempotencyKey.trim()
    : c.req.header("idempotency-key")?.trim() ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(executionId) ||
    !title || title.length > 160 || !idempotencyKey || idempotencyKey.length > 240
  ) return c.json({ error: "invalid_body" }, 400);
  const [source] = await db.select({ execution: agentExecutions, run: runs }).from(agentExecutions)
    .innerJoin(runs, eq(runs.id, agentExecutions.runId))
    .where(and(
      eq(agentExecutions.orgId, c.get("orgId")),
      eq(agentExecutions.id, executionId),
      eq(agentExecutions.mode, "native_child"),
      eq(runs.threadId, c.req.param("parentThreadId")),
    )).limit(1);
  if (!source) return c.json({ error: "not_found" }, 404);
  const eventRows = source.execution.nativeSessionId
    ? await loadCanonicalExecutionEvents({
        runId: source.run.id,
        provider: source.execution.provider,
        nativeSessionId: source.execution.nativeSessionId,
        afterDeliverySeq: 0,
        limit: CHILD_TRANSCRIPT_EVENT_LIMIT + 1,
      })
    : [];
  const transcriptTruncated = eventRows.length > CHILD_TRANSCRIPT_EVENT_LIMIT;
  const events = eventRows.slice(0, CHILD_TRANSCRIPT_EVENT_LIMIT);
  const redact = await strictOrgSecretRedactor(c.get("orgId"));
  const envelopeKeys = new Set([
    "schemaVersion", "eventId", "seq", "runId", "threadId", "turnId",
    "identity", "deliverySeq", "revision", "kind", "ts",
  ]);
  const transcriptContext = events.map((event) => ({
    cursor: event.deliverySeq,
    kind: event.kind,
    timestamp: event.ts,
    event: redact.unknown(Object.fromEntries(
      Object.entries(event).filter(([key]) => !envelopeKeys.has(key)),
    )),
  }));
  const fallbackContext = events.length > 0 ? null : await Promise.all([
    listArtifactsForOrg({
      orgId: c.get("orgId"),
      runId: source.run.id,
      limit: CONTINUE_REFERENCE_LIMIT + 1,
    }),
    db.select({ metadata: finishedWorkReceipts.metadata }).from(finishedWorkReceipts).where(and(
      eq(finishedWorkReceipts.orgId, c.get("orgId")),
      eq(finishedWorkReceipts.runId, source.run.id),
    )).orderBy(desc(finishedWorkReceipts.createdAt), desc(finishedWorkReceipts.id))
      .limit(CONTINUE_REFERENCE_LIMIT + 1),
  ]).then(([artifacts, receipts]) => ({
    artifacts: artifacts.slice(0, CONTINUE_REFERENCE_LIMIT).map((artifact) => ({
      artifact_id: artifact.id,
      name: artifact.name,
      content_type: artifact.contentType,
      digest: artifact.sha256,
      revision: artifact.workpieceRevision,
      preview_url: `/api/artifacts/${artifact.id}/content`,
      download_url: `/api/artifacts/${artifact.id}/content?download=1`,
    })),
    artifacts_truncated: artifacts.length > CONTINUE_REFERENCE_LIMIT,
    code_references: receipts.flatMap((receipt) => {
      const commitSha = typeof receipt.metadata?.commitSha === "string" ? receipt.metadata.commitSha : null;
      const pullRequestUrl = typeof receipt.metadata?.pullRequestUrl === "string" ? receipt.metadata.pullRequestUrl : null;
      return commitSha || pullRequestUrl
        ? [{ commit_sha: commitSha, pull_request_url: pullRequestUrl }]
        : [];
    }).slice(0, CONTINUE_REFERENCE_LIMIT),
    code_references_truncated: receipts.length > CONTINUE_REFERENCE_LIMIT,
    source_result: (source.run.summary ?? "").slice(0, CONTINUE_RESULT_MAX_CHARS),
    source_result_truncated: (source.run.summary ?? "").length > CONTINUE_RESULT_MAX_CHARS,
  }));
  const context = JSON.stringify(redact.unknown(
    events.length > 0 ? transcriptContext : { transcript: [], durable_fallback: fallbackContext },
  ));
  const prefix = "Continue this work in a new durable useAgent child session. This is captured context, not a claim that the native execution itself was resumed.\n\n";
  const emptyContext = "No canonical transcript was captured; inspect the parent task and continue from its durable result.";
  let bounded = context.slice(0, CHILD_CONTEXT_MAX_CHARS - prefix.length);
  while (Buffer.byteLength(prefix + bounded, "utf8") > CHILD_CONTEXT_MAX_BYTES) bounded = bounded.slice(0, -1);
  const prompt = prefix + (bounded || emptyContext);
  const outcome = await createChildSession({
    orgId: c.get("orgId"),
    actorId: c.get("userId"),
    parentRunId: source.run.id,
    threadId: source.run.threadId,
    title,
    prompt,
    engine: source.run.engine,
    model: source.run.model,
    repos: source.run.repos,
    memoryScope: source.run.memoryScope,
    idempotencyKey,
    relationshipKind: "continued_from_native",
    sourceExecutionId: source.execution.id,
  });
  if (outcome.status === "conflict") return c.json({ error: "idempotency_key_reused" }, 409);
  return c.json({
    id: outcome.child.id,
    thread_id: outcome.child.threadId,
    replayed: outcome.status === "replayed",
    context_truncated: bounded.length < context.length,
    transcript_truncated: transcriptTruncated,
    source_event_ref: `useagent://runs/${source.run.id}/executions/${source.execution.id}/canonical-events`,
    last_included_cursor: events.at(-1)?.deliverySeq ?? null,
  }, outcome.status === "created" ? 201 : 200);
});

routes.post("/:threadId/messages", async (c) => {
  if (!productChildComposerEnabled(c.get("orgId"))) return c.json({ error: "not_found" }, 404);
  const idempotencyKey = c.req.header("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 240) return c.json({ error: "invalid_idempotency_key" }, 400);
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > 128 * 1024) return c.json({ error: "request_too_large" }, 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return c.json({ error: "invalid_json" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "invalid_body" }, 400);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "text" && key !== "attachments")) return c.json({ error: "invalid_body" }, 400);
  const text = typeof record.text === "string" ? record.text.trim() : "";
  const attachments = record.attachments === undefined ? [] : record.attachments;
  if (
    !text || !Array.isArray(attachments) || attachments.length > 10 ||
    attachments.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
  ) {
    return c.json({ error: "invalid_body" }, 400);
  }
  const attachmentIds = [...new Set(attachments as string[])];
  try {
    const accepted = await acceptThreadFollowup({
      orgId: c.get("orgId"),
      actorId: c.get("userId"),
      threadId: c.req.param("threadId"),
      text,
      attachmentIds,
      idempotencyKey,
    });
    if (accepted.status === "not_found") return c.json({ error: "not_found" }, 404);
    if (accepted.status === "stale_parent") return c.json({ error: "stale_parent_run" }, 409);
    if (accepted.status === "attachments_require_actor") return c.json({ error: "attachments_require_actor" }, 403);
    if (accepted.status === "conflict") return c.json({ error: "idempotency_key_reused", reason: accepted.reason }, 409);
    if (accepted.status === "replayed") return c.json({ id: accepted.runId }, 200);
    await pumpThread(c.req.param("threadId"));
    const queue = await runQueueView(accepted.runId);
    return c.json({ id: accepted.runId, status: queue?.state === "queued" ? "queued" : "running", queue }, 201);
  } catch (error) {
    if (error instanceof RunPromptTooLargeError) return c.json({ error: error.code }, 413);
    if (error instanceof UploadClaimError) return c.json({ error: "upload_unavailable" }, 409);
    if (error instanceof RunAdmissionClosedError) return c.json({ error: error.code, retryable: true }, 503);
    if (error instanceof FleetQueueLimitError) return c.json({ error: error.code, retryable: true, limit: error.limit }, 429);
    throw error;
  }
});

export const threadRelationshipRoutes = routes;
