import type { SlackConfig } from "../../env";
import { resolveSlackClient, type DeliveryResult, type SlackClient } from "../client";
import { assertNever } from "../../util/exhaustive";
import { readStagedBytes, removeStaged } from "../upload-staging";
import { getArtifact, toArtifactDescriptor } from "../../artifacts/repo";
import { artifactStorage } from "../../artifacts/storage";
import { recordProviderEvent } from "../../runs/provider-events";
import { claimDue, markDead, markDelivered, markRetry, resetStuckDelivering, type ClaimedRow } from "./repo";
import type { ProcessResult, SlackDeliveryOutcome } from "./types";

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
  switch (row.kind) {
    case "post_message": {
      const channel = string("channel");
      const text = string("text");
      if (!channel || !text) return { ok: false, class: "permanent", message: "invalid_payload" };
      return client.postMessage({ channel, text, threadTs: string("threadTs") });
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
        const stagedPath = string("stagedPath");
        if (artifactId) {
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
    default:
      return assertNever(row.kind, "unhandled slack outbox kind");
  }
}

/** Remove an upload row's staged bytes once the row is terminal (delivered or
 *  dead). A retry keeps them for the next attempt. No-op for other kinds. */
async function cleanupStagedIfUpload(row: ClaimedRow): Promise<void> {
  if (row.kind !== "upload_file") return;
  try {
    const p = JSON.parse(row.payload) as { stagedPath?: string };
    if (p.stagedPath) await removeStaged(p.stagedPath);
  } catch {
    /* malformed payload — nothing to clean */
  }
}

/** Emit a truthful timeline receipt only after Slack accepted the upload. The
 * outbox remains the delivery authority; enqueue alone is not delivery. */
async function recordArtifactDelivered(row: ClaimedRow): Promise<void> {
  if (row.kind !== "upload_file") return;
  let artifactId: string | undefined;
  try {
    const payload = JSON.parse(row.payload) as { artifactId?: unknown };
    artifactId = typeof payload.artifactId === "string" ? payload.artifactId : undefined;
  } catch {
    return;
  }
  if (!artifactId) return; // legacy staged-path row
  const artifact = await getArtifact(artifactId);
  if (!artifact) return;
  await recordProviderEvent(
    {
      id: `artifact.delivered:${artifact.runId}:${artifact.id}`,
      runId: artifact.runId,
      threadId: artifact.threadId,
      provider: "skynet",
      eventType: "artifact.delivered",
      payload: { ...toArtifactDescriptor(artifact), destination: "slack" },
    },
    { critical: true },
  );
}

/** Deliver one claimed row and transition its state. */
async function deliverOne(client: SlackClient, row: ClaimedRow): Promise<SlackDeliveryOutcome> {
  const result = await attempt(client, row);
  if (result.ok) {
    await markDelivered(row.id);
    await recordArtifactDelivered(row);
    await cleanupStagedIfUpload(row);
    return { status: "delivered" };
  }

  // A permanent error will never succeed → dead-letter immediately.
  if (result.class === "permanent") {
    await markDead(row.id, { errorClass: "permanent", lastError: result.message });
    await cleanupStagedIfUpload(row);
    return { status: "dead", errorClass: "permanent" };
  }

  // Otherwise retry until attempts are exhausted, then dead-letter.
  const attemptsAfter = row.attemptCount + 1;
  if (attemptsAfter >= row.maxAttempts) {
    await markDead(row.id, { errorClass: result.class, lastError: result.message });
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
export async function processDue(client: SlackClient): Promise<ProcessResult> {
  const rows = await claimDue();
  let delivered = 0;
  let retried = 0;
  let dead = 0;
  for (const row of rows) {
    const outcome = await deliverOne(client, row);
    if (outcome.status === "delivered") delivered++;
    else if (outcome.status === "retry") retried++;
    else dead++;
  }
  return { delivered, retried, dead };
}

// ── relay (background delivery loop) ──────────────────────────────────────

let relayConfig: SlackConfig | null = null;
let relayTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** A single guarded pass (no overlapping passes). */
async function pass(): Promise<void> {
  if (inFlight || !relayConfig) return;
  inFlight = true;
  try {
    await processDue(resolveSlackClient(relayConfig));
  } catch (err) {
    console.error("[slack-outbox] delivery pass failed:", (err as Error).message);
  } finally {
    inFlight = false;
  }
}

/**
 * Start the delivery relay: on boot reset orphaned `delivering` rows (a crash
 * mid-send) back to pending and deliver everything due, then poll on an
 * interval. Idempotent — a second call just refreshes the config.
 */
export function startSlackOutboxRelay(config: SlackConfig): void {
  relayConfig = config;
  void resetStuckDelivering()
    .catch((err) => console.error("[slack-outbox] reset stuck failed:", (err as Error).message))
    .then(() => pass());
  if (!relayTimer) {
    relayTimer = setInterval(() => void pass(), TICK_MS);
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
  if (relayTimer) {
    clearInterval(relayTimer);
    relayTimer = null;
  }
}
