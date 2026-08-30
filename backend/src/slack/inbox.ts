import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { commands, type CommandState } from "../db/schema";
import type { SlackEnvelope } from "./events";
import { MAX_INBOUND_SLACK_FILES } from "./inbound-files";
import { findSlackUser, findSlackWorkspace } from "./workspaces";
import { findSlackThread } from "./repo";

export const SLACK_INBOX_EVENT = "slack.inbox.event" as const;
const INBOX_KEY_PREFIX = "slack-inbox:";
const MAX_PAYLOAD_BYTES = 1_000_000;
const MAX_ATTEMPTS = 8;
const CLAIM_LIMIT = 10;
const STALE_CLAIM_SECONDS = 30;
const PUMP_INTERVAL_MS = 250;
const CLAIM_HEARTBEAT_MS = 10_000;
const TERMINAL_REDACT_AFTER_SECONDS = 24 * 60 * 60;
const TERMINAL_DELETE_AFTER_SECONDS = 7 * 24 * 60 * 60;
const RETENTION_BATCH = 100;
const RETENTION_INTERVAL_MS = 60_000;
const MAX_TEXT_CHARS = 80_000;
const MAX_METADATA_CHARS = 4_096;
const DEFER_BASE_MS = 1_000;
const DEFER_MAX_MS = 60_000;
const DEFER_MAX_COUNT = 20;
const DEFER_EXPIRE_MS = 30 * 60 * 1000;
const ROOT_PROBATION_BASE_MS = 250;
const ROOT_PROBATION_MAX_MS = 5_000;
const ROOT_PROBATION_MAX_COUNT = 12;
const ROOT_PROBATION_EXPIRE_MS = 2 * 60 * 1000;

export interface SlackInboxIdentity {
  readonly teamId: string | null;
  readonly channel: string | null;
  readonly messageTs: string | null;
  readonly eventId: string | null;
  readonly slackUserId: string | null;
  readonly orgId: string | null;
  readonly actorId: string | null;
}

export interface SlackInboxPayload {
  readonly schema: 1;
  readonly envelope: SlackEnvelope;
  readonly identity: SlackInboxIdentity;
  /** null means file staging has not run; an array (even empty) means its exact
   * result was checkpointed and must be reused. */
  readonly stagedAttachmentIds: readonly string[] | null;
  readonly defer: {
    readonly reason: string;
    readonly count: number;
    readonly firstDeferredAt: string;
    readonly nextAttemptAt: string;
  } | null;
}

interface ClaimedSlackInboxEvent {
  readonly id: string;
  readonly payload: string;
  readonly attemptCount: number;
  readonly claimToken: string;
}

export interface SlackInboxClaim {
  readonly payload: SlackInboxPayload;
  readonly checkpointStagedAttachmentIds: (ids: readonly string[]) => Promise<void>;
}

export type SlackInboxOutcome =
  | { readonly status: "completed" }
  | { readonly status: "retryable_unavailable"; readonly error: string }
  | { readonly status: "waiting_for_root" }
  | { readonly status: "permanent"; readonly error: string };

export type SlackInboxHandler = (claim: SlackInboxClaim) => Promise<SlackInboxOutcome>;

export class StaleSlackInboxClaimError extends Error {
  constructor() {
    super("Slack inbox claim is no longer current");
    this.name = "StaleSlackInboxClaimError";
  }
}

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function boundedString(value: unknown, max: number, field: string): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > max) throw new Error(`Slack inbox ${field} exceeds ${max} characters`);
  return value;
}

/** Strip provider-added fields and retain only the data the Slack adapter uses. */
export function canonicalizeSlackEnvelope(envelope: SlackEnvelope): SlackEnvelope {
  const event = envelope.event;
  return {
    type: boundedString(envelope.type, 64, "type"),
    event_id: boundedString(envelope.event_id, 256, "event_id"),
    team_id: boundedString(envelope.team_id, 256, "team_id"),
    authorizations: envelope.authorizations?.slice(0, 1).map((authorization) => ({
      user_id: boundedString(authorization.user_id, 256, "authorization.user_id"),
    })),
    ...(event ? {
      event: {
        type: boundedString(event.type, 64, "event.type"),
        subtype: boundedString(event.subtype, 64, "event.subtype"),
        channel: boundedString(event.channel, 256, "event.channel"),
        channel_type: boundedString(event.channel_type, 64, "event.channel_type"),
        user: boundedString(event.user, 256, "event.user"),
        bot_id: boundedString(event.bot_id, 256, "event.bot_id"),
        text: boundedString(event.text, MAX_TEXT_CHARS, "event.text"),
        ts: boundedString(event.ts, 256, "event.ts"),
        thread_ts: boundedString(event.thread_ts, 256, "event.thread_ts"),
        files: event.files?.slice(0, MAX_INBOUND_SLACK_FILES).map((file) => ({
          id: boundedString(file.id, 256, "file.id"),
          name: boundedString(file.name, MAX_METADATA_CHARS, "file.name"),
          size: typeof file.size === "number" && Number.isFinite(file.size) ? file.size : undefined,
          mimetype: boundedString(file.mimetype, 512, "file.mimetype"),
          url_private_download: boundedString(
            file.url_private_download,
            MAX_METADATA_CHARS,
            "file.url_private_download",
          ),
          url_private: boundedString(file.url_private, MAX_METADATA_CHARS, "file.url_private"),
        })),
      },
    } : {}),
  };
}

export function slackInboxKey(envelope: SlackEnvelope): string {
  const teamId = envelope.team_id?.trim() || "missing-team";
  const channel = envelope.event?.channel?.trim();
  const ts = envelope.event?.ts?.trim();
  const eventId = envelope.event_id?.trim();
  // Slack retries preserve event_id. Channel/message time is the fallback for
  // legacy envelopes that omit it; run acceptance separately uses channel:ts
  // so two delivery IDs for one message still cannot mint two runs.
  const identity = eventId || (channel && ts ? `${channel}:${ts}` : hash(JSON.stringify(envelope)));
  return `${INBOX_KEY_PREFIX}${teamId}:${identity}`;
}

function ordinaryChannelThreadReply(envelope: SlackEnvelope): {
  teamId: string;
  channel: string;
  threadTs: string;
} | null {
  const event = envelope.event;
  if (
    event?.type !== "message" ||
    event.channel_type === "im" ||
    !envelope.team_id ||
    !event.channel ||
    !event.ts ||
    !event.thread_ts ||
    event.thread_ts === event.ts
  ) {
    return null;
  }
  return { teamId: envelope.team_id, channel: event.channel, threadTs: event.thread_ts };
}

export type SlackInboxPersistDecision = "drop" | "persist" | "awaiting_root_commit";

/**
 * DB-backed classification for ordinary channel replies after the pure gate.
 * A valid mapped workspace reply whose root is not visible yet is never ACK-
 * dropped: root and reply HTTP/Socket deliveries can commit in either order.
 */
export async function classifySlackInboxEvent(
  envelope: SlackEnvelope,
): Promise<SlackInboxPersistDecision> {
  const reply = ordinaryChannelThreadReply(envelope);
  if (!reply) return "persist";
  const [workspace, exact, legacy] = await Promise.all([
    findSlackWorkspace(reply.teamId),
    findSlackThread(reply.teamId, reply.channel, reply.threadTs),
    findSlackThread("__legacy__", reply.channel, reply.threadTs),
  ]);
  if (!workspace) return "drop";
  if (exact) return exact.orgId === workspace.orgId ? "persist" : "drop";
  if (legacy) return legacy.orgId === workspace.orgId ? "persist" : "drop";
  return "awaiting_root_commit";
}

/** Existing indexed commands.thread_id representation of a Slack root thread. */
export function slackInboxThreadId(envelope: SlackEnvelope): string | null {
  const teamId = envelope.team_id?.trim();
  const channel = envelope.event?.channel?.trim();
  const threadTs = envelope.event?.thread_ts?.trim() || envelope.event?.ts?.trim();
  if (!teamId || !channel || !threadTs) return null;
  return `slack-inbox-thread:${hash(JSON.stringify([teamId, channel, threadTs]))}`;
}

async function resolveIngressIdentity(envelope: SlackEnvelope): Promise<SlackInboxIdentity> {
  const teamId = envelope.team_id?.trim() || null;
  const slackUserId = envelope.event?.user?.trim() || null;
  const workspace = teamId ? await findSlackWorkspace(teamId) : null;
  const sender = workspace && teamId && slackUserId
    ? await findSlackUser(teamId, slackUserId)
    : null;
  return {
    teamId,
    channel: envelope.event?.channel?.trim() || null,
    messageTs: envelope.event?.ts?.trim() || null,
    eventId: envelope.event_id?.trim() || null,
    slackUserId,
    orgId: workspace?.orgId ?? null,
    actorId: sender?.orgId === workspace?.orgId ? sender?.userId ?? null : null,
  };
}

function serializePayload(payload: SlackInboxPayload): string {
  const raw = JSON.stringify(payload);
  if (Buffer.byteLength(raw, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error(`Slack inbox payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return raw;
}

type PersistOverride = (envelope: SlackEnvelope) => Promise<"created" | "duplicate">;
let persistOverride: PersistOverride | null = null;
type BeforePersistInsertOverride = (envelope: SlackEnvelope) => Promise<void>;
let beforePersistInsertOverride: BeforePersistInsertOverride | null = null;

/** Test-only fault injection at the transport durability boundary. */
export function setSlackInboxPersisterForTest(override: PersistOverride | null): void {
  persistOverride = override;
}

/** Test-only barrier immediately before the durable INSERT. */
export function setSlackInboxBeforePersistInsertForTest(
  override: BeforePersistInsertOverride | null,
): void {
  beforePersistInsertOverride = override;
}

/** Resolve immutable tenant identity and durably record a verified event. */
export async function persistSlackInboxEvent(
  envelope: SlackEnvelope,
  decision: Exclude<SlackInboxPersistDecision, "drop"> = "persist",
): Promise<"created" | "duplicate"> {
  if (persistOverride) return persistOverride(envelope);
  const canonicalEnvelope = canonicalizeSlackEnvelope(envelope);
  const identity = await resolveIngressIdentity(canonicalEnvelope);
  const semanticPayload: SlackInboxPayload = {
    schema: 1,
    envelope: canonicalEnvelope,
    identity,
    stagedAttachmentIds: null,
    defer: null,
  };
  const now = Date.now();
  const payload = serializePayload(decision === "awaiting_root_commit"
    ? {
        ...semanticPayload,
        defer: {
          reason: "awaiting_root_commit",
          count: 0,
          firstDeferredAt: new Date(now).toISOString(),
          nextAttemptAt: new Date(now + ROOT_PROBATION_BASE_MS).toISOString(),
        },
      }
    : semanticPayload);
  const id = slackInboxKey(canonicalEnvelope);
  // Probation timing is mutable retry state, not provider-event identity.
  const payloadFingerprint = hash(serializePayload(semanticPayload));
  await beforePersistInsertOverride?.(canonicalEnvelope);
  const inserted = await db
    .insert(commands)
    .values({
      id,
      idempotencyKey: id,
      orgId: identity.orgId,
      actorId: identity.actorId,
      kind: SLACK_INBOX_EVENT,
      threadId: slackInboxThreadId(canonicalEnvelope),
      payload,
      payloadFingerprint,
      state: "queued" satisfies CommandState,
      attemptCount: 0,
    })
    .onConflictDoNothing({ target: commands.id })
    .returning({ id: commands.id });
  if (inserted.length > 0) {
    kickSlackInbox();
    return "created";
  }
  const [existing] = await db
    .select({ fingerprint: commands.payloadFingerprint, kind: commands.kind })
    .from(commands)
    .where(eq(commands.id, id))
    .limit(1);
  if (!existing || existing.kind !== SLACK_INBOX_EVENT || existing.fingerprint !== payloadFingerprint) {
    throw new Error("Slack inbox identity was reused with a different payload");
  }
  // A later provider retry may be the only chance to heal a crash after run
  // acceptance but before Slack thread/outbox linkage. Re-open only successful
  // rows; permanent identity/payload failures remain failed closed.
  await db
    .update(commands)
    .set({ payload, state: "queued", attemptCount: 0, error: null, updatedAt: new Date() })
    .where(and(
      eq(commands.id, id),
      eq(commands.state, "completed"),
      isNull(commands.error),
    ));
  kickSlackInbox();
  return "duplicate";
}

function parsePayload(raw: unknown): SlackInboxPayload {
  if (typeof raw !== "string") throw new Error("invalid Slack inbox payload");
  const parsed = JSON.parse(raw) as Partial<SlackInboxPayload>;
  if (parsed.schema !== 1 || !parsed.envelope || !parsed.identity) {
    throw new Error("invalid Slack inbox payload");
  }
  if (parsed.stagedAttachmentIds !== null && !Array.isArray(parsed.stagedAttachmentIds)) {
    throw new Error("invalid Slack inbox attachment checkpoint");
  }
  if (parsed.defer !== null && typeof parsed.defer !== "object") {
    throw new Error("invalid Slack inbox defer metadata");
  }
  return {
    schema: 1,
    envelope: parsed.envelope,
    identity: parsed.identity,
    stagedAttachmentIds: parsed.stagedAttachmentIds === null
      ? null
      : parsed.stagedAttachmentIds.filter((id): id is string => typeof id === "string"),
    defer: parsed.defer ?? null,
  };
}

async function claimSlackInboxEvents(limit = CLAIM_LIMIT): Promise<ClaimedSlackInboxEvent[]> {
  const claimToken = crypto.randomUUID();
  const rows = (await db.execute(sql`
    with due as (
      select id from commands
      where kind = ${SLACK_INBOX_EVENT}
        and attempt_count < ${MAX_ATTEMPTS}
        and (
          state = 'queued' and (
            payload::jsonb -> 'defer' = 'null'::jsonb
            or (payload::jsonb #>> '{defer,nextAttemptAt}')::timestamptz <= now()
          )
          or (state = 'dispatched' and updated_at < now() - (${STALE_CLAIM_SECONDS} * interval '1 second'))
        )
      order by created_at asc, id asc
      limit ${limit}
      for update skip locked
    )
    update commands c
    set state = 'dispatched', attempt_count = attempt_count + 1,
        updated_at = now(), error = ${claimToken}
    from due where c.id = due.id
    returning c.id, c.payload, c.attempt_count`)) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as string,
    payload: row.payload as string,
    attemptCount: Number(row.attempt_count),
    claimToken,
  }));
}

async function failExhaustedStaleClaims(): Promise<number> {
  const rows = await db.execute(sql`
    update commands
    set state = 'failed', error = 'retry_exhausted_after_restart', updated_at = now()
    where kind = ${SLACK_INBOX_EVENT}
      and state = 'dispatched'
      and attempt_count >= ${MAX_ATTEMPTS}
      and updated_at < now() - (${STALE_CLAIM_SECONDS} * interval '1 second')
    returning id`);
  return rows.length;
}

interface ClaimHeartbeat {
  stop(): Promise<boolean>;
}

function startClaimHeartbeat(row: ClaimedSlackInboxEvent): ClaimHeartbeat {
  let stopped = false;
  let lost = false;
  let pending = Promise.resolve();
  const beat = () => {
    pending = pending.then(async () => {
      if (stopped || lost) return;
      const updated = await db.execute(sql`
        update commands set updated_at = now()
        where id = ${row.id} and state = 'dispatched' and error = ${row.claimToken}
        returning id`);
      if (updated.length === 0) lost = true;
    }).catch((error) => {
      console.error("[slack] inbox heartbeat failed:", (error as Error).message);
    });
  };
  const timer = setInterval(beat, CLAIM_HEARTBEAT_MS);
  timer.unref?.();
  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await pending;
      return lost;
    },
  };
}

async function updateClaim(
  row: ClaimedSlackInboxEvent,
  values: Partial<typeof commands.$inferInsert>,
): Promise<void> {
  const updated = await db
    .update(commands)
    .set({ ...values, updatedAt: new Date() })
    .where(and(
      eq(commands.id, row.id),
      eq(commands.state, "dispatched"),
      eq(commands.error, row.claimToken),
    ))
    .returning({ id: commands.id });
  if (updated.length === 0) throw new StaleSlackInboxClaimError();
}

async function checkpointStagedAttachmentIds(
  row: ClaimedSlackInboxEvent,
  current: SlackInboxPayload,
  ids: readonly string[],
): Promise<void> {
  const payload = serializePayload({ ...current, stagedAttachmentIds: [...ids] });
  await updateClaim(row, { payload });
}

async function completeClaim(row: ClaimedSlackInboxEvent): Promise<void> {
  await updateClaim(row, { state: "completed", error: null });
}

async function failClaim(row: ClaimedSlackInboxEvent, error: string): Promise<void> {
  await updateClaim(row, { state: "failed", error: error.slice(0, 500) });
}

async function requeueClaim(
  row: ClaimedSlackInboxEvent,
  error: string,
): Promise<void> {
  await updateClaim(row, { state: "queued", error: error.slice(0, 500) });
}

async function deferClaim(
  row: ClaimedSlackInboxEvent,
  payload: SlackInboxPayload,
  reason: string,
  policy: {
    readonly baseMs: number;
    readonly maxMs: number;
    readonly maxCount: number;
    readonly expireMs: number;
  } = {
    baseMs: DEFER_BASE_MS,
    maxMs: DEFER_MAX_MS,
    maxCount: DEFER_MAX_COUNT,
    expireMs: DEFER_EXPIRE_MS,
  },
): Promise<"queued" | "expired"> {
  const now = Date.now();
  const previous = payload.defer?.reason === reason ? payload.defer : null;
  const firstDeferredAt = previous?.firstDeferredAt ?? new Date(now).toISOString();
  const firstMs = Date.parse(firstDeferredAt);
  const count = (previous?.count ?? 0) + 1;
  if (
    count >= policy.maxCount ||
    !Number.isFinite(firstMs) ||
    now - firstMs >= policy.expireMs
  ) {
    return "expired";
  }
  const delayMs = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, count - 1));
  const nextPayload = serializePayload({
    ...payload,
    defer: {
      reason,
      count,
      firstDeferredAt,
      nextAttemptAt: new Date(now + delayMs).toISOString(),
    },
  });
  const updated = await db.execute(sql`
    update commands
    set state = 'queued',
        attempt_count = greatest(attempt_count - 1, 0),
        payload = ${nextPayload},
        error = ${reason.slice(0, 500)},
        updated_at = now()
    where id = ${row.id} and state = 'dispatched' and error = ${row.claimToken}
    returning id`);
  if (updated.length === 0) throw new StaleSlackInboxClaimError();
  return "queued";
}

async function completeExpiredRootProbation(row: ClaimedSlackInboxEvent): Promise<void> {
  await updateClaim(row, {
    state: "completed",
    error: "permanent_noop:awaiting_root_commit_expired",
  });
}

export type SlackInboxIdentityVerdict =
  | { readonly status: "verified"; readonly orgId: string; readonly actorId: string | null }
  | { readonly status: "ignored" }
  | { readonly status: "rebound"; readonly error: string };

/** Verify current bindings still equal the immutable ingress-time identity. */
export async function verifySlackInboxIdentity(
  payload: SlackInboxPayload,
): Promise<SlackInboxIdentityVerdict> {
  const identity = payload.identity;
  if (!identity.teamId || !identity.orgId) return { status: "ignored" };
  const workspace = await findSlackWorkspace(identity.teamId);
  if (workspace?.orgId !== identity.orgId) {
    return { status: "rebound", error: "slack_workspace_binding_changed" };
  }
  if (!identity.slackUserId) {
    return identity.actorId === null
      ? { status: "verified", orgId: identity.orgId, actorId: null }
      : { status: "rebound", error: "slack_sender_binding_changed" };
  }
  const sender = await findSlackUser(identity.teamId, identity.slackUserId);
  const currentActor = sender?.orgId === identity.orgId ? sender.userId : null;
  if (currentActor !== identity.actorId) {
    return { status: "rebound", error: "slack_sender_binding_changed" };
  }
  return { status: "verified", orgId: identity.orgId, actorId: identity.actorId };
}

export interface SlackInboxPassResult {
  readonly claimed: number;
  readonly completed: number;
  readonly requeued: number;
  readonly failed: number;
}

export async function processSlackInbox(handler: SlackInboxHandler): Promise<SlackInboxPassResult> {
  const exhausted = await failExhaustedStaleClaims();
  const rows = await claimSlackInboxEvents();
  const heartbeats = new Map(rows.map((row) => [row.id, startClaimHeartbeat(row)]));
  let completed = 0;
  let requeued = 0;
  let failed = exhausted;
  for (const row of rows) {
    const heartbeat = heartbeats.get(row.id)!;
    try {
      let payload = parsePayload(row.payload);
      const outcome = await handler({
        payload,
        checkpointStagedAttachmentIds: async (ids) => {
          await checkpointStagedAttachmentIds(row, payload, ids);
          payload = { ...payload, stagedAttachmentIds: [...ids] };
        },
      });
      if (await heartbeat.stop()) throw new StaleSlackInboxClaimError();
      if (outcome.status === "completed") {
        await completeClaim(row);
        completed++;
      } else if (outcome.status === "retryable_unavailable") {
        const deferred = await deferClaim(row, payload, outcome.error);
        if (deferred === "expired") {
          await failClaim(row, `deferred_expired:${outcome.error}`);
          failed++;
        } else requeued++;
      } else if (outcome.status === "waiting_for_root") {
        const deferred = await deferClaim(row, payload, "awaiting_root_commit", {
          baseMs: ROOT_PROBATION_BASE_MS,
          maxMs: ROOT_PROBATION_MAX_MS,
          maxCount: ROOT_PROBATION_MAX_COUNT,
          expireMs: ROOT_PROBATION_EXPIRE_MS,
        });
        if (deferred === "expired") {
          await completeExpiredRootProbation(row);
          completed++;
        } else requeued++;
      } else {
        await failClaim(row, outcome.error);
        failed++;
      }
    } catch (error) {
      await heartbeat.stop();
      if (error instanceof StaleSlackInboxClaimError) continue;
      if (row.attemptCount >= MAX_ATTEMPTS) {
        await failClaim(row, (error as Error).message);
        failed++;
      } else {
        await requeueClaim(row, (error as Error).message);
        requeued++;
      }
    }
  }
  return { claimed: rows.length, completed, requeued, failed };
}

export interface SlackInboxRetentionResult {
  readonly redacted: number;
  readonly deleted: number;
}

/** Redact terminal payloads after one day and delete them after seven days. */
export async function maintainSlackInboxRetention(): Promise<SlackInboxRetentionResult> {
  const redacted = await db.execute(sql`
    with due as (
      select id from commands
      where kind = ${SLACK_INBOX_EVENT}
        and state in ('completed', 'failed')
        and created_at < now() - (${TERMINAL_REDACT_AFTER_SECONDS} * interval '1 second')
        and payload not like '%"redacted"%'
      order by created_at asc
      limit ${RETENTION_BATCH}
      for update skip locked
    )
    update commands c
    set payload = json_build_object(
          'schema', 1,
          'redacted', true,
          'terminalState', c.state,
          'orgId', c.org_id,
          'actorId', c.actor_id
        )::text,
        updated_at = now()
    from due where c.id = due.id
    returning c.id`);
  const deleted = await db.execute(sql`
    with due as (
      select id from commands
      where kind = ${SLACK_INBOX_EVENT}
        and state in ('completed', 'failed')
        and created_at < now() - (${TERMINAL_DELETE_AFTER_SECONDS} * interval '1 second')
      order by created_at asc
      limit ${RETENTION_BATCH}
      for update skip locked
    )
    delete from commands c using due where c.id = due.id
    returning c.id`);
  return { redacted: redacted.length, deleted: deleted.length };
}

let handler: SlackInboxHandler | null = null;
let pumpTimer: ReturnType<typeof setInterval> | null = null;
let pumpInFlight = false;
let rerunRequested = false;
let lastRetentionSweepAt = 0;

async function pump(): Promise<void> {
  if (!handler) return;
  if (pumpInFlight) {
    rerunRequested = true;
    return;
  }
  pumpInFlight = true;
  try {
    await processSlackInbox(handler);
    if (Date.now() - lastRetentionSweepAt >= RETENTION_INTERVAL_MS) {
      await maintainSlackInboxRetention();
      lastRetentionSweepAt = Date.now();
    }
  } catch (error) {
    console.error("[slack] inbox pump failed:", (error as Error).message);
  } finally {
    pumpInFlight = false;
    if (rerunRequested) {
      rerunRequested = false;
      queueMicrotask(() => void pump());
    }
  }
}

/** Start boot recovery plus low-latency interval processing. */
export function startSlackInboxPump(nextHandler: SlackInboxHandler): void {
  handler = nextHandler;
  void pump();
  if (pumpTimer) return;
  pumpTimer = setInterval(() => void pump(), PUMP_INTERVAL_MS);
  pumpTimer.unref?.();
}

/** Wake the pump after a committed inbox insert. */
export function kickSlackInbox(): void {
  void pump();
}

export function stopSlackInboxPumpForTest(): void {
  handler = null;
  rerunRequested = false;
  if (pumpTimer) clearInterval(pumpTimer);
  pumpTimer = null;
  pumpInFlight = false;
}
