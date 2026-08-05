/**
 * Slack Events-API ingest, adapted to the runs model. Given a verified
 * `event_callback` envelope, this decides whether the message is for us, maps it
 * onto a run (root or `parent_run_id` reply), 👀-acks, and registers a
 * completion watcher. Kept deliberately small — QM's turn-handler (approvals,
 * reactions, mirroring, attachments, agent-requests) is DEFERRED.
 *
 * Gating (from QM's events.ts, condensed):
 *  - DM (`channel_type: "im"`)      → always ours.
 *  - `app_mention`                  → always ours (Slack only sends it on mention).
 *  - channel `message` w/ a mention → SKIP: the paired `app_mention` covers it
 *    (and shares our `channel:ts` dedupe key, so duplicates collapse anyway).
 *  - channel `message` thread reply → only if we already root that thread.
 *  - anything else                  → ignored (no channel-wide chatter).
 */
import { slackConfig } from "../env";
import type { MemoryScope } from "../db/schema";
import { getDevContext } from "../seed";
import { getRunForOrg } from "../runs/repo";
import { acceptRunCommand } from "../commands";
import { pumpThread } from "../worker";
import { resolveSlackClient } from "./client";
import { findSlackThread, linkSlackThread } from "./repo";
import { watchSlackRun } from "./watcher";
import { enqueueAddReaction } from "./outbox";

// Bounded FIFO deduper — collapses Slack retries AND the app_mention/message
// pair for a channel mention (both carry the same `channel:ts`). No LRU dep;
// a Set is insertion-ordered so the oldest key evicts first.
function createDeduper(max = 1000): { seen(key: string): boolean; forget(key: string): void } {
  const set = new Set<string>();
  return {
    seen(key) {
      if (set.has(key)) return true;
      set.add(key);
      if (set.size > max) {
        const oldest = set.values().next().value;
        if (oldest !== undefined) set.delete(oldest);
      }
      return false;
    },
    forget(key) {
      set.delete(key);
    },
  };
}

const deduper = createDeduper();

export interface SlackEnvelope {
  type?: string;
  challenge?: string;
  authorizations?: Array<{ user_id?: string }>;
  event?: {
    type?: string;
    subtype?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
}

function botUserIdOf(body: SlackEnvelope): string {
  return body.authorizations?.[0]?.user_id ?? "";
}

/** Strip the bot's own mention token(s) and collapse whitespace. */
function cleanPrompt(text: string, botUserId: string): string {
  let t = text;
  if (botUserId) t = t.replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g"), " ");
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Process a verified `event_callback`. Awaited by the route so a created run is
 * observable the moment the POST returns — the DB writes are fast (well inside
 * Slack's 3s ack budget); outbound Slack calls are fire-and-forget / deferred.
 */
export async function handleSlackEvent(body: SlackEnvelope): Promise<void> {
  const config = slackConfig();
  if (!config) return;

  const event = body.event;
  const type = event?.type;
  if (!event || (type !== "app_mention" && type !== "message")) return;

  // Never react to bot-authored messages (loop guard) or non-plain message
  // subtypes (edits/deletes/joins — deferred).
  if (event.bot_id) return;
  const botUserId = botUserIdOf(body);
  if (botUserId && event.user === botUserId) return;
  if (type === "message" && event.subtype) return;

  const channel = event.channel;
  const ts = event.ts;
  if (!channel || !ts) return;

  const rawText = typeof event.text === "string" ? event.text : "";
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : undefined;
  const isDm = event.channel_type === "im";
  const isThreadReply = Boolean(threadTs && threadTs !== ts);
  const isMention = botUserId ? rawText.includes(`<@${botUserId}>`) : false;

  // A message threads under its thread root (replies) or under itself (top-level).
  const slackThreadTs = threadTs ?? ts;
  const link = await findSlackThread(channel, slackThreadTs);

  // Gating for non-DM plain `message` events.
  if (!isDm && type === "message") {
    if (isMention) return; // the paired app_mention handles it
    if (!isThreadReply) return; // untargeted channel chatter
    if (!link) return; // a thread we have no stake in
  }

  // Dedupe last, so a genuinely-ours message reserves its key exactly once.
  const key = `${channel}:${ts}`;
  if (deduper.seen(key)) return;

  const prompt = cleanPrompt(rawText, botUserId);
  if (!prompt) {
    deduper.forget(key);
    return;
  }

  // Org identity: v1 is single-tenant — a Slack request has no better-auth
  // session, so runs are scoped to the seeded dev org (an existing thread keeps
  // its original org). Multi-workspace → org mapping is deferred.
  const orgId = link?.orgId ?? getDevContext().orgId;
  const userId = getDevContext().userId;

  // Threading: an existing Slack thread → reply under its root run (inherits the
  // skynet thread); a new thread → a root run under its own id.
  let parentRunId: string | null = null;
  const runId = crypto.randomUUID();
  let threadId: string = runId;
  // Slack has no scope selector: a reply inherits its thread-root's scope, a new
  // thread defaults to "org". (Personal-scope Slack runs would need a verified
  // per-actor identity, which the current dev-org fallback doesn't provide.)
  let memoryScope: MemoryScope = "org";
  if (link) {
    const parent = await getRunForOrg(orgId, link.rootRunId);
    if (parent) {
      parentRunId = parent.id;
      threadId = parent.threadId;
      memoryScope = parent.memoryScope;
    }
  }

  // Enter through the durable command lane (no idempotency key — Slack dedupes
  // by external event id upstream). The mailbox pump preserves per-thread order:
  // a reply in an active Slack thread waits for the prior turn.
  await acceptRunCommand({
    idempotencyKey: null,
    orgId,
    actorId: userId,
    run: {
      id: runId,
      prompt,
      model: config.model,
      engine: config.defaultEngine,
      parentRunId,
      threadId,
      // Slack runs work in a bare sandbox (no repo picker) and default to org memory.
      repo: null,
      memoryScope,
    },
  });

  // First bot interaction in this Slack thread → remember it as the root. Linked
  // BEFORE dispatch so run finalization (runs/finalize.ts) can always resolve the
  // Slack thread to enqueue the reply, even for a run that finishes near-instantly.
  if (!link) {
    await linkSlackThread({ channel, threadTs: slackThreadTs, rootRunId: runId, orgId });
  }

  await pumpThread(threadId);

  const client = resolveSlackClient(config);
  // Durable receipt reaction (survives a restart; keyed once per message).
  void enqueueAddReaction({
    idempotencyKey: `slack-ack:${channel}:${ts}`,
    channel,
    timestamp: ts,
    name: "eyes",
  });
  watchSlackRun({ runId, client, channel, threadTs: slackThreadTs });
}
