import type { SlackConfig } from "../../env";
import { resolveSlackClient, type DeliveryResult, type SlackClient } from "../client";
import { assertNever } from "../../util/exhaustive";
import { readStagedBytes } from "../upload-staging";
import { getArtifact } from "../../artifacts/repo";
import { artifactStorage } from "../../artifacts/storage";
import { recordProviderEvent } from "../../runs/provider-events";
import { backfillSlackOutboxOrgScope, claimDue, listPendingSlackReceipts, markDead, markDelivered, markRetry, markSlackReceiptEmitted, resetStuckDelivering, updatePayload, type ClaimedRow } from "./repo";
import {
  addSlackStreamedChars,
  createSlackRunResponse,
  disableSlackNativeStream,
  findSlackRunResponse,
  setSlackFallbackMessageTs,
  setSlackNativeStream,
} from "../repo";
import type { ProcessResult, SlackDeliveryOutcome, SlackErrorClass } from "./types";
import {
  markdownChunksFor,
  type SlackSessionStatus,
  type SlackStreamChunk,
  type SlackStreamTaskDisplayMode,
} from "../streaming";
import { findSlackWorkspace } from "../workspaces";
import { resolveSlackBotTokenForWorkspace } from "../../integrations/slack-token-resolver";
import { getRun } from "../../runs/repo";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { slackOutbox } from "../../db/schema";
import {
  cleanupStagedIfUpload,
  recordArtifactDelivered,
} from "./artifact-delivery";

// ---------------------------------------------------------------------------
// Slack outbox delivery worker + relay. Claims due rows, calls Slack, and on
// failure classifies the error into retry-with-backoff (Retry-After for 429),
// or dead-letter once attempts are exhausted / the error is permanent.
// ---------------------------------------------------------------------------

/** Exponential-backoff base/cap (ms). Overridable so tests/live-proofs go fast. */
const BASE_MS = Number(process.env.SLACK_OUTBOX_BASE_MS ?? 1000);
const CAP_MS = Number(process.env.SLACK_OUTBOX_CAP_MS ?? 60_000);
const TICK_MS = Number(process.env.SLACK_OUTBOX_TICK_MS ?? 2000);

/** Full-jittered exponential backoff for retry attempt N (1-based). */
function backoffMs(attempt: number): number {
  const exp = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempt - 1));
  return exp + Math.floor(Math.random() * Math.min(1000, exp * 0.25));
}

/** Normalize a stored chunk to the DOCUMENTED wire shape. Pre-migration rows
 *  carried a `markdown_text` text field, `task_update` fields nested under
 *  `task` (with `task_id`), and plan items typed `task` - Slack rejected all of
 *  them, so legacy plan items are dropped and the rest are converted. */
function normalizeStreamChunk(raw: unknown): SlackStreamChunk | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const chunk = raw as Record<string, unknown>;
  if (chunk.type === "markdown_text") {
    const text =
      typeof chunk.text === "string" && chunk.text
        ? chunk.text
        : typeof chunk.markdown_text === "string" && chunk.markdown_text
          ? chunk.markdown_text
          : null;
    return text ? { type: "markdown_text", text } : null;
  }
  if (chunk.type === "plan_update") {
    return typeof chunk.title === "string" && chunk.title ? { type: "plan_update", title: chunk.title } : null;
  }
  if (chunk.type === "task_update") {
    const source = (
      chunk.task && typeof chunk.task === "object" && !Array.isArray(chunk.task) ? chunk.task : chunk
    ) as Record<string, unknown>;
    const id =
      typeof source.id === "string" && source.id
        ? source.id
        : typeof source.task_id === "string" && source.task_id
          ? source.task_id
          : null;
    const title = typeof source.title === "string" && source.title ? source.title : null;
    const status =
      source.status === "in_progress" || source.status === "complete" || source.status === "error"
        ? source.status
        : null;
    if (!id || !title || !status) return null;
    return {
      type: "task_update",
      id,
      title,
      status,
      ...(typeof source.details === "string" && source.details ? { details: source.details } : {}),
      ...(typeof source.output === "string" && source.output ? { output: source.output } : {}),
    };
  }
  return null;
}

function streamChunks(value: unknown): readonly SlackStreamChunk[] {
  return Array.isArray(value)
    ? value.map(normalizeStreamChunk).filter((chunk): chunk is SlackStreamChunk => chunk !== null)
    : [];
}

function sessionStatus(value: unknown): SlackSessionStatus | undefined {
  return value === "processing" || value === "active" ? value : undefined;
}

function taskDisplayMode(value: unknown): SlackStreamTaskDisplayMode | undefined {
  if (value === "plan") return "plan";
  // Legacy rows stored the retired "task_update" mode; it meant the timeline.
  if (value === "timeline" || value === "task_update") return "timeline";
  return undefined;
}

async function postFallbackChunks(
  client: SlackClient,
  row: ClaimedRow,
  payload: Record<string, unknown>,
  channel: string,
  threadTs: string,
  fallbackChunks: readonly string[],
): Promise<DeliveryResult> {
  if (fallbackChunks.length === 0) {
    return { ok: false, class: "permanent", message: "invalid_payload" };
  }
  for (let i = 0; i < fallbackChunks.length; i++) {
    const res = await client.postMessage({ channel, text: fallbackChunks[i]!, threadTs });
    if (!res.ok) {
      if (i > 0) {
        await updatePayload(row.id, JSON.stringify({ ...payload, fallbackChunks: fallbackChunks.slice(i) }));
      }
      return res;
    }
  }
  return { ok: true };
}

/** Make the actual Slack call for a row, returning the classified result. */
async function attempt(client: SlackClient, row: ClaimedRow): Promise<DeliveryResult> {
  let p: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, class: "permanent", message: "invalid_payload" };
    }
    p = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, class: "permanent", message: "invalid_payload" };
  }
  const string = (key: string): string | undefined =>
    typeof p[key] === "string" && p[key] ? p[key] : undefined;

  // Terminal run truth wins over delayed/retried live-progress rows. Without
  // this fence, a backoff or restart can re-open the spinner/stream after the
  // terminal stop row already settled the Slack surface.
  const staleLiveRow =
    row.kind === "post_card" ||
    row.kind === "start_stream" ||
    row.kind === "append_stream" ||
    (row.kind === "set_session_status" && p.status === "processing") ||
    (row.kind === "set_thread_status" && typeof p.status === "string" && p.status.length > 0);
  const runId = string("runId") ?? string("rootRunId");
  if (staleLiveRow && runId) {
    const run = await getRun(runId);
    const terminal = run?.status === "completed" || run?.status === "failed";
    if (terminal && staleLiveRow) return { ok: true };
  }
  switch (row.kind) {
    case "post_message": {
      const channel = string("channel");
      // New rows carry `chunks` (a long reply split into sequential thread
      // messages); pre-migration rows carry a single `text`.
      const chunks = Array.isArray(p.chunks)
        ? p.chunks.filter((c): c is string => typeof c === "string" && c.length > 0)
        : [string("text")].filter((c): c is string => c !== undefined);
      if (!channel || chunks.length === 0) {
        return { ok: false, class: "permanent", message: "invalid_payload" };
      }
      const threadTs = string("threadTs");
      for (let i = 0; i < chunks.length; i++) {
        const res = await client.postMessage({ channel, text: chunks[i]!, threadTs });
        if (!res.ok) {
          // Persist the chunk cursor: a retry resumes at the FAILED chunk, so
          // already-posted ones are not duplicated. (A crash between the post
          // and this write can still re-post one chunk - the outbox's accepted
          // at-least-once trade.)
          if (i > 0) await updatePayload(row.id, JSON.stringify({ ...p, chunks: chunks.slice(i) }));
          return res;
        }
      }
      return { ok: true };
    }
    case "add_reaction": {
      const channel = string("channel");
      const timestamp = string("timestamp");
      const name = string("name");
      if (!channel || !timestamp || !name) {
        return { ok: false, class: "permanent", message: "invalid_payload" };
      }
      return client.addReaction({ channel, timestamp, name });
    }
    case "upload_file": {
      const channel = string("channel");
      const filename = string("filename");
      if (!channel || !filename) {
        return { ok: false, class: "permanent", message: "invalid_payload" };
      }
      let bytes: Buffer;
      try {
        const artifactId = string("artifactId");
        const artifactSha256 = string("artifactSha256");
        const artifactStorageKey = string("artifactStorageKey");
        const stagedPath = string("stagedPath");
        if (artifactId && artifactSha256 && artifactStorageKey) {
          const artifact = await getArtifact(artifactId);
          if (!artifact) return { ok: false, class: "permanent", message: "artifact_missing" };
          if (artifact.orgId !== string("orgId")) {
            return { ok: false, class: "permanent", message: "artifact_scope_mismatch" };
          }
          const stored = await artifactStorage().read(artifactStorageKey);
          if (createHash("sha256").update(stored).digest("hex") !== artifactSha256) {
            return { ok: false, class: "permanent", message: "artifact_digest_mismatch" };
          }
          if (typeof p.size !== "number" || stored.byteLength !== p.size) {
            return { ok: false, class: "permanent", message: "artifact_size_mismatch" };
          }
          bytes = Buffer.from(stored);
        } else if (artifactId) {
          // Legacy rows predate immutable revision identity.
          const artifact = await getArtifact(artifactId);
          if (!artifact) return { ok: false, class: "permanent", message: "artifact_missing" };
          const stored = await artifactStorage().read(artifact.storageKey);
          if (stored.byteLength !== artifact.sizeBytes) {
            return { ok: false, class: "permanent", message: "artifact_size_mismatch" };
          }
          bytes = Buffer.from(stored);
        } else if (stagedPath) {
          bytes = await readStagedBytes(stagedPath);
        } else {
          return { ok: false, class: "permanent", message: "upload_source_missing" };
        }
      } catch {
        return { ok: false, class: "permanent", message: "artifact_bytes_missing" };
      }
      return client.uploadFile({
        channel,
        threadTs: string("threadTs"),
        filename,
        title: string("title"),
        bytes,
      });
    }
    case "post_card": {
      const teamId = string("teamId");
      const channel = string("channel");
      const threadTs = string("threadTs");
      const runId = string("runId") ?? string("rootRunId");
      const text = string("text");
      const blocks = Array.isArray(p.blocks) ? p.blocks : undefined;
      if (!teamId || !channel || !threadTs || !runId || !text) {
        return { ok: false, class: "permanent", message: "invalid_payload" };
      }
      const res = await client.postMessage({ channel, text, threadTs, blocks });
      // Persist the card ts so later updates target the SAME message. A crash
      // between the post and this write redelivers the row (at-least-once): the
      // idempotency key already bounds it, and a re-post is a benign duplicate
      // card - the update path still finds a ts on the healed row next time.
      if (res.ok && res.ts) {
        await createSlackRunResponse({ runId, teamId, channel, threadTs });
        await setSlackFallbackMessageTs(runId, res.ts);
      }
      return res;
    }
    case "update_card": {
      const teamId = string("teamId");
      const channel = string("channel");
      const threadTs = string("threadTs");
      const runId = string("runId") ?? string("rootRunId");
      const text = string("text");
      const blocks = Array.isArray(p.blocks) ? p.blocks : undefined;
      // The plain-text fallback (chunked) - posted when there is no card to update.
      const fallbackChunks = Array.isArray(p.fallbackChunks)
        ? p.fallbackChunks.filter((c): c is string => typeof c === "string" && c.length > 0)
        : [];
      if (!teamId || !channel || !threadTs || !runId || !text) {
        return { ok: false, class: "permanent", message: "invalid_payload" };
      }
      // Resolve the card ts written by the post_card row. When it exists, advance
      // the card in place; a transient/rate-limited failure retries the whole row.
      const response = await findSlackRunResponse(runId);
      if (response?.fallbackMessageTs) {
        const res = await client.updateMessage({ channel, ts: response.fallbackMessageTs, text, blocks });
        // chat.update succeeded, or failed transiently (retry the row) - but a
        // PERMANENT update failure (card deleted, message not found) must not
        // strand the answer: fall through to posting it as a fresh reply below.
        if (res.ok || res.class !== "permanent") return res;
      }
      // No card ts (post never landed) or the card is gone: post the answer as a
      // fresh CHUNKED reply so the answer is NEVER lost. Cursor-resumes like
      // post_message so a mid-sequence retry does not re-post delivered chunks.
      return postFallbackChunks(client, row, p, channel, threadTs, fallbackChunks);
    }
    case "set_session_status": {
      const teamId = string("teamId");
      const channel = string("channel");
      const threadTs = string("threadTs");
      const status = sessionStatus(p.status);
      if (!teamId || !channel || !threadTs || !status) {
        return { ok: false, class: "permanent", message: "invalid_payload" };
      }
      return client.setSessionStatus({ channel, threadTs, status });
    }
    case "set_thread_status": {
      const teamId = string("teamId");
      const channel = string("channel");
      const threadTs = string("threadTs");
      // The empty string is meaningful: it CLEARS the shimmer.
      const status = typeof p.status === "string" ? p.status : undefined;
      if (!teamId || !channel || !threadTs || status === undefined) {
        return { ok: false, class: "permanent", message: "invalid_payload" };
      }
      return client.setThreadStatus({ channel, threadTs, status });
    }
    case "start_stream": {
      const teamId = string("teamId");
      const channel = string("channel");
      const threadTs = string("threadTs");
      const runId = string("runId") ?? string("rootRunId");
      const mode = taskDisplayMode(p.taskDisplayMode);
      const chunks = streamChunks(p.chunks);
      const fallbackBlocks = Array.isArray(p.fallbackBlocks) ? p.fallbackBlocks : undefined;
      const fallbackText = string("fallbackText");
      if (!teamId || !channel || !threadTs || !runId || !mode || chunks.length === 0 || !fallbackText) {
        return { ok: false, class: "permanent", message: "invalid_payload" };
      }
      await createSlackRunResponse({ runId, teamId, channel, threadTs });
      const stream = await client.startStream({
        channel,
        threadTs,
        taskDisplayMode: mode,
        chunks,
        recipientTeamId: string("recipientTeamId"),
        recipientUserId: string("recipientUserId"),
      });
      if (stream.ok && stream.ts) {
        await setSlackNativeStream(runId, stream.ts, mode);
        return stream;
      }
      if (!stream.ok && stream.class === "rate_limited") return stream;
      // ANY other stream outcome (feature off, restricted workspace, invalid,
      // missing ts) falls back ONCE to the Block Kit card for this run - the
      // stream ts stays null so every later row rides the card path too.
      const fallback = await client.postMessage({ channel, threadTs, text: fallbackText, blocks: fallbackBlocks });
      if (fallback.ok && fallback.ts) await setSlackFallbackMessageTs(runId, fallback.ts);
      return fallback;
    }
    case "append_stream": {
      const teamId = string("teamId");
      const channel = string("channel");
      const threadTs = string("threadTs");
      const runId = string("runId") ?? string("rootRunId");
      const chunks = streamChunks(p.chunks);
      const narrationOffset =
        typeof p.narrationOffset === "number" && Number.isFinite(p.narrationOffset)
          ? p.narrationOffset
          : undefined;
      const fallbackBlocks = Array.isArray(p.fallbackBlocks) ? p.fallbackBlocks : undefined;
      const fallbackText = string("fallbackText");
      if (!teamId || !channel || !threadTs || !runId || chunks.length === 0 || !fallbackText) {
        return { ok: false, class: "permanent", message: "invalid_payload" };
      }
      const response = await findSlackRunResponse(runId);
      if (!response) return { ok: false, class: "transient", message: "stream_not_started" };
      let nativeJustDisabled = false;
      if (response.nativeStreamTs) {
        // Offset fence for narration text: retries and backoff can reorder
        // outbox rows, but streamed text must stay exact. Behind the accepted
        // offset means a crash replay already delivered this segment (done);
        // ahead means an earlier segment is still pending (retry later).
        if (narrationOffset !== undefined) {
          if (response.streamedChars > narrationOffset) return { ok: true };
          if (response.streamedChars < narrationOffset) {
            return { ok: false, class: "transient", message: "narration_gap" };
          }
        }
        const stream = await client.appendStream({ channel, threadTs, messageTs: response.nativeStreamTs, chunks });
        if (stream.ok) {
          const markdownChars = chunks.reduce(
            (n, c) => (c.type === "markdown_text" ? n + c.text.length : n),
            0,
          );
          await addSlackStreamedChars(runId, markdownChars);
          return stream;
        }
        if (stream.class === "rate_limited") return stream;
        // The stream can no longer be written (stopped, expired, restricted):
        // fall back ONCE for this run instead of storming retries.
        await disableSlackNativeStream(runId);
        nativeJustDisabled = true;
      }
      if (response.fallbackMessageTs) {
        return client.updateMessage({ channel, ts: response.fallbackMessageTs, text: fallbackText, blocks: fallbackBlocks });
      }
      // Progress is best-effort: with the stream just disabled and no card to
      // update, drop the row rather than post stray surfaces after the fact.
      if (nativeJustDisabled) return { ok: true };
      return { ok: false, class: "transient", message: "stream_not_started" };
    }
    case "stop_stream": {
      const teamId = string("teamId");
      const channel = string("channel");
      const threadTs = string("threadTs");
      const runId = string("runId") ?? string("rootRunId");
      const text = string("text");
      const chunks = streamChunks(p.chunks);
      const narrationText = string("narrationText") ?? "";
      const closingMarkdown = string("closingMarkdown") ?? "";
      const blocks = Array.isArray(p.blocks) ? p.blocks : undefined;
      // Full final card (with the answer) for the card-update path; legacy rows
      // carried a single blocks set for both paths.
      const cardBlocks = Array.isArray(p.fallbackBlocks) ? p.fallbackBlocks : blocks;
      const fallbackChunks = Array.isArray(p.fallbackChunks)
        ? p.fallbackChunks.filter((c): c is string => typeof c === "string" && c.length > 0)
        : [];
      if (!teamId || !channel || !threadTs || !runId || !text || chunks.length === 0 || !blocks) {
        return { ok: false, class: "permanent", message: "invalid_payload" };
      }
      const response = await findSlackRunResponse(runId);
      if (response?.nativeStreamTs) {
        // Append exactly the reply text the body does NOT yet contain: the
        // narration tail past the accepted offset, then the closing markdown.
        const tail = narrationText.slice(Math.min(response.streamedChars, narrationText.length));
        const stopChunks = [...markdownChunksFor(tail + closingMarkdown), ...chunks];
        const stopped = await client.stopStream({
          channel,
          threadTs,
          messageTs: response.nativeStreamTs,
          chunks: stopChunks,
          blocks,
        });
        if (stopped.ok || stopped.class === "rate_limited") return stopped;
        await disableSlackNativeStream(runId);
      }
      if (response?.fallbackMessageTs) {
        const updated = await client.updateMessage({ channel, ts: response.fallbackMessageTs, text, blocks: cardBlocks });
        if (updated.ok || updated.class !== "permanent") return updated;
      }
      return postFallbackChunks(client, row, p, channel, threadTs, fallbackChunks);
    }
    default:
      return assertNever(row.kind, "unhandled slack outbox kind");
  }
}

/** Deliver one claimed row and transition its state. */
function rowTeamScope(row: ClaimedRow): {
  readonly teamId: string | null;
  readonly orgId: string | null;
} {
  try {
    const payload = JSON.parse(row.payload) as { teamId?: unknown; orgId?: unknown };
    return {
      teamId: typeof payload.teamId === "string" && payload.teamId ? payload.teamId : null,
      orgId: typeof payload.orgId === "string" && payload.orgId ? payload.orgId : null,
    };
  } catch {
    return { teamId: null, orgId: null };
  }
}

type SlackTeamClientResolver = (
  teamId: string,
  expectedOrgId: string | null,
) => Promise<SlackClient | null>;

async function recordSlackDeliveryFailure(
  row: ClaimedRow,
  info: { readonly errorClass: string; readonly lastError: string },
): Promise<void> {
  let runId: string | null = null;
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    for (const key of ["deliveryRunId", "runId", "rootRunId"] as const) {
      if (typeof payload[key] === "string" && payload[key]) {
        runId = payload[key];
        break;
      }
    }
  } catch {
    return;
  }
  if (!runId) return;
  const run = await getRun(runId);
  if (!run) return;
  await recordProviderEvent(
    {
      id: `slack.delivery.failed:${row.id}`,
      runId: run.id,
      threadId: run.threadId,
      provider: "skynet",
      eventType: "delivery.failed",
      payload: {
        destination: "slack",
        delivery_kind: row.kind,
        error_class: info.errorClass,
        reason: info.lastError.slice(0, 200),
      },
    },
    { critical: true, required: true },
  );
}

async function deadLetter(
  row: ClaimedRow,
  info: { readonly errorClass: SlackErrorClass; readonly lastError: string },
): Promise<void> {
  await markDead(row.id, info);
  console.error("[slack-outbox] dead-letter", JSON.stringify({
    idempotencyKey: row.idempotencyKey,
    kind: row.kind,
    errorClass: info.errorClass,
    reason: info.lastError.slice(0, 200),
  }));
}

/** Drain the receipt half of the Slack outbox. Terminal state and all receipt
 * source data are already durable on the same row; a failed projection leaves
 * receipt_emitted_at NULL for the next tick/restart. Stable provider-event ids
 * make a crash after event insert but before cursor update harmless. */
export async function drainSlackDeliveryReceipts(): Promise<void> {
  const rows = await listPendingSlackReceipts();
  for (const row of rows) {
    try {
      if (row.state === "dead") {
          let errorClass: SlackErrorClass = "permanent";
          let lastError = "delivery_failed";
          try {
            const [stored] = await db
              .select({ errorClass: slackOutbox.errorClass, lastError: slackOutbox.lastError })
              .from(slackOutbox)
              .where(eq(slackOutbox.id, row.id))
              .limit(1);
            errorClass = stored?.errorClass ?? "permanent";
            lastError = stored?.lastError ?? "delivery_failed";
          } catch {
            // Keep the receipt pending when its terminal reason cannot be read.
            continue;
          }
          await recordSlackDeliveryFailure(row, { errorClass, lastError });
      } else if (row.kind === "upload_file") {
        await recordArtifactDelivered(row);
      }
      await markSlackReceiptEmitted(row.id);
    } catch (error) {
      console.error("[slack-outbox] receipt projection failed:", (error as Error).message);
    }
  }
}

async function deliverOne(
  defaultClient: SlackClient | null,
  row: ClaimedRow,
  resolveTeamClient?: SlackTeamClientResolver,
): Promise<SlackDeliveryOutcome> {
  const { teamId, orgId } = rowTeamScope(row);
  if (teamId && !orgId) {
    await deadLetter(row, {
      errorClass: "permanent",
      lastError: "workspace_scope_missing",
    });
    return { status: "dead", errorClass: "permanent" };
  }
  let client = defaultClient;
  if (teamId && resolveTeamClient) {
    try {
      client = await resolveTeamClient(teamId, orgId);
    } catch {
      await deadLetter(row, {
        errorClass: "permanent",
        lastError: "integration_credential_invalid",
      });
      return { status: "dead", errorClass: "permanent" };
    }
  }
  if (!client) {
    await deadLetter(row, {
      errorClass: "permanent",
      lastError: "integration_not_connected",
    });
    return { status: "dead", errorClass: "permanent" };
  }
  const result = await attempt(client, row);
  if (result.ok) {
    await markDelivered(row.id);
    await cleanupStagedIfUpload(row);
    return { status: "delivered" };
  }

  // A permanent error will never succeed → dead-letter immediately.
  if (result.class === "permanent") {
    await deadLetter(row, { errorClass: "permanent", lastError: result.message });
    await cleanupStagedIfUpload(row);
    return { status: "dead", errorClass: "permanent" };
  }

  // Otherwise retry until attempts are exhausted, then dead-letter.
  const attemptsAfter = row.attemptCount + 1;
  if (attemptsAfter >= row.maxAttempts) {
    await deadLetter(row, { errorClass: result.class, lastError: result.message });
    await cleanupStagedIfUpload(row);
    return { status: "dead", errorClass: result.class };
  }
  // 429 honors Retry-After; transient uses exponential backoff.
  const delayMs = result.class === "rate_limited" ? result.retryAfterMs : backoffMs(attemptsAfter);
  const nextAttemptAt = new Date(Date.now() + delayMs);
  await markRetry(row.id, { nextAttemptAt, errorClass: result.class, lastError: result.message });
  return { status: "retry", errorClass: result.class, nextAttemptAt };
}

/** One delivery pass: claim due rows and deliver each. Returns tallies. */
export async function processDue(
  client: SlackClient | null,
  resolveTeamClient?: SlackTeamClientResolver,
): Promise<ProcessResult> {
  const rows = await claimDue();
  let delivered = 0;
  let retried = 0;
  let dead = 0;
  for (const row of rows) {
    const outcome = await deliverOne(client, row, resolveTeamClient);
    if (outcome.status === "delivered") delivered++;
    else if (outcome.status === "retry") retried++;
    else dead++;
  }
  await drainSlackDeliveryReceipts();
  return { delivered, retried, dead };
}

// ── relay (background delivery loop) ──────────────────────────────────────

let relayConfig: SlackConfig | null = null;
let relayTimer: ReturnType<typeof setInterval> | null = null;
let repairTimer: ReturnType<typeof setTimeout> | null = null;
let repairInFlight = false;
let relayReady = false;
let inFlight = false;
let rerunRequested = false;

/** A single guarded pass (no overlapping passes). */
async function pass(): Promise<void> {
  if (!relayConfig || !relayReady) return;
  if (inFlight) {
    rerunRequested = true;
    return;
  }
  const config = relayConfig;
  inFlight = true;
  try {
    const legacyClient = config.legacyBotToken
      ? resolveSlackClient({ apiUrl: config.apiUrl, botToken: config.legacyBotToken })
      : null;
    await processDue(legacyClient, async (teamId, expectedOrgId) => {
      const workspace = await findSlackWorkspace(teamId);
      if (!workspace || (expectedOrgId && workspace.orgId !== expectedOrgId)) return null;
      const botToken = await resolveSlackBotTokenForWorkspace({
        orgId: workspace.orgId,
        teamId,
        config,
      });
      return botToken
        ? resolveSlackClient({ apiUrl: config.apiUrl, botToken })
        : null;
    });
  } catch (err) {
    console.error("[slack-outbox] delivery pass failed:", (err as Error).message);
  } finally {
    inFlight = false;
    if (rerunRequested && relayConfig) {
      rerunRequested = false;
      queueMicrotask(() => void pass());
    }
  }
}

async function repairAndStart(): Promise<void> {
  if (!relayConfig || relayReady || repairInFlight) return;
  repairInFlight = true;
  try {
    await backfillSlackOutboxOrgScope();
    await resetStuckDelivering();
    if (!relayConfig) return;
    relayReady = true;
    await pass();
  } catch (err) {
    console.error("[slack-outbox] boot repair failed:", (err as Error).message);
    if (relayConfig && !repairTimer) {
      repairTimer = setTimeout(() => {
        repairTimer = null;
        void repairAndStart();
      }, BASE_MS);
      repairTimer.unref?.();
    }
  } finally {
    repairInFlight = false;
  }
}

/**
 * Start the delivery relay: on boot reset orphaned `delivering` rows (a crash
 * mid-send) back to pending and deliver everything due, then poll on an
 * interval. Idempotent — a second call just refreshes the config.
 */
export function startSlackOutboxRelay(config: SlackConfig): void {
  relayConfig = config;
  if (relayReady) void pass();
  else void repairAndStart();
  if (!relayTimer) {
    relayTimer = setInterval(() => {
      if (relayReady) void pass();
      else void repairAndStart();
    }, TICK_MS);
    relayTimer.unref?.();
  }
}

/** Trigger an immediate delivery pass (called after an enqueue). */
export function kickSlackOutbox(): void {
  void pass();
}

/** Stop the relay (clears the interval and disables passes). For tests that
 *  drive processDue() explicitly; the app never stops it. */
export function stopSlackOutboxRelay(): void {
  relayConfig = null;
  relayReady = false;
  repairInFlight = false;
  rerunRequested = false;
  if (repairTimer) {
    clearTimeout(repairTimer);
    repairTimer = null;
  }
  if (relayTimer) {
    clearInterval(relayTimer);
    relayTimer = null;
  }
}
