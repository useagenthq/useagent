/**
 * Slack Events-API ingest, adapted to the runs model. Given a verified
 * `event_callback` envelope, this resolves the workspace to a tenant identity
 * (fail closed), decides whether the message is for us, stages inbound
 * attachments, maps it onto a run (root or `parent_run_id` reply), 👀-acks, and
 * registers a completion watcher. Kept deliberately small — QM's turn-handler
 * (approvals, reactions, mirroring, agent-requests) is DEFERRED.
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
import { getRunForOrg } from "../runs/repo";
import { acceptRunCommand } from "../commands";
import { pumpThread } from "../worker";
import { resolveSlackClient } from "./client";
import { stageInboundSlackFiles, type SlackInboundFileMeta } from "./inbound-files";
import { findSlackThread, linkSlackThread } from "./repo";
import { watchSlackRun } from "./watcher";
import { resolveSlackWorkspace } from "./workspaces";
import { enqueueAddReaction, enqueuePostMessage } from "./outbox";
import { defaultModelForEngine, isModelAllowedForEngine } from "../runs/model-policy";
import {
  isSlackSwitchableEngine,
  modelCatalogLine,
  parseSlackDirectives,
  resolveModelToken,
} from "./model-directive";

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
  /** The workspace the event came from — resolved to an org/user via
   *  slack_workspaces (fail closed; see workspaces.ts). */
  team_id?: string;
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
    /** Inbound attachments (Slack file objects) — downloaded bounded and staged
     *  through the uploads lane (see inbound-files.ts). */
    files?: SlackInboundFileMeta[];
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
 * Process a verified `event_callback`. Runs ASYNC behind the transport ack
 * (both the HTTP route and Socket Mode ack first, then hand the envelope here),
 * so run acceptance, attachment staging, and outbound calls never eat into
 * Slack's 3s ack budget.
 */
export async function handleSlackEvent(body: SlackEnvelope): Promise<void> {
  const config = slackConfig();
  if (!config) return;

  const event = body.event;
  const type = event?.type;
  if (!event || (type !== "app_mention" && type !== "message")) return;

  // Never react to bot-authored messages (loop guard) or non-plain message
  // subtypes (edits/deletes/joins — deferred). `file_share` is the one subtype
  // let through: it is how a plain message with attachments arrives.
  if (event.bot_id) return;
  const botUserId = botUserIdOf(body);
  if (botUserId && event.user === botUserId) return;
  if (type === "message" && event.subtype && event.subtype !== "file_share") return;

  const channel = event.channel;
  const ts = event.ts;
  if (!channel || !ts) return;

  // Operator channel allowlist: when set, ONLY events from listed channel ids
  // are processed (DMs included - a DM channel id is not in the list). Keeps a
  // freshly connected workspace scoped to a designated test channel until the
  // adapter is opened up.
  if (config.channelAllowlist.size > 0 && !config.channelAllowlist.has(channel)) return;

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

  // Workspace identity — FAIL CLOSED. An event from a workspace with no
  // slack_workspaces mapping is ignored (logged once per team id); nothing ever
  // falls back to a seeded org. Resolved BEFORE dedupe so an unmapped
  // workspace's event never reserves a dedupe key (a retry after the operator
  // adds the mapping still lands).
  const workspace = await resolveSlackWorkspace(body.team_id);
  if (!workspace) return;

  // Dedupe last, so a genuinely-ours message reserves its key exactly once.
  const key = `${channel}:${ts}`;
  if (deduper.seen(key)) return;

  // Org identity: an existing thread keeps its original org; a new thread is
  // scoped by the workspace mapping. The actor is the workspace's bound user.
  const orgId = link?.orgId ?? workspace.orgId;
  const userId = workspace.userId;

  // Inbound attachments: download bounded (count/size caps, Slack CDN only) and
  // stage through the uploads lane so the run claims them like browser uploads.
  const files = Array.isArray(event.files) ? event.files : [];
  const attachmentIds =
    files.length > 0
      ? await stageInboundSlackFiles({ files, botToken: config.botToken, orgId, userId })
      : [];

  let prompt = cleanPrompt(rawText, botUserId);
  if (!prompt) {
    // A files-only message still runs (the attachments ARE the request); an
    // empty message with no staged files stays a no-op.
    if (attachmentIds.length === 0) {
      deduper.forget(key);
      return;
    }
    prompt = "Review the attached files.";
  }

  // Threading: an existing Slack thread → reply under its root run (inherits the
  // skynet thread); a new thread → a root run under its own id.
  let parentRunId: string | null = null;
  const runId = crypto.randomUUID();
  let threadId: string = runId;
  // Slack has no scope selector: a reply inherits its thread-root's scope, a new
  // thread defaults to "org". (Personal-scope Slack runs would need a verified
  // per-Slack-user identity; the workspace mapping binds one actor per team.)
  let memoryScope: MemoryScope = "org";
  // A reply MUST run on the thread's original engine and model - engines keep
  // per-thread native session state in the sandbox, and a cross-engine turn
  // lands on a runtime shaped for a different provider (observed live: a codex
  // reply on an opencode-born thread failed its runtime readiness). Mirrors the
  // API reply path, which inherits the parent engine and refuses mismatches.
  let engine = config.defaultEngine;
  let model = config.model;
  let parent: Awaited<ReturnType<typeof getRunForOrg>> | null = null;
  if (link) {
    parent = await getRunForOrg(orgId, link.rootRunId);
    if (parent) {
      parentRunId = parent.id;
      threadId = parent.threadId;
      memoryScope = parent.memoryScope;
      engine = parent.engine as typeof engine;
      model = parent.model;
    }
  }

  // In-message switching: `engine:x` / `model:y` tokens at the start of the
  // message. Model switches apply to any turn (same-engine model switching is
  // a supported provider capability); engine switches only start NEW threads -
  // an existing thread's engine owns its native session state.
  const { directives, rest } = parseSlackDirectives(prompt);
  const guide = (text: string) =>
    enqueuePostMessage({
      idempotencyKey: `slack-directive:${channel}:${ts}`,
      channel,
      text,
      threadTs: slackThreadTs,
    });
  if (directives.engine || directives.model) {
    if (rest) prompt = rest;
    else if (attachmentIds.length === 0) {
      await guide("Include your request in the same message as the directive, e.g. `model:sol summarize this thread`.");
      return;
    }
    if (directives.engine) {
      if (!isSlackSwitchableEngine(directives.engine)) {
        await guide(`Unknown engine \`${directives.engine}\`. Available: opencode, claude, codex.`);
        return;
      }
      if (parent && directives.engine !== engine) {
        await guide(`This thread runs on \`${engine}\` and cannot switch engines mid-thread. Start a new thread to use \`${directives.engine}\`.`);
        return;
      }
      if (!parent && directives.engine !== engine) {
        engine = directives.engine;
        model = defaultModelForEngine(engine);
      }
    }
    if (directives.model) {
      const resolved = resolveModelToken(engine, directives.model);
      if (!resolved) {
        await guide(`Unknown model \`${directives.model}\` for \`${engine}\`. Available: ${modelCatalogLine(engine)}.`);
        return;
      }
      model = resolved;
    }
  }
  if (!isModelAllowedForEngine(engine, model)) {
    model = defaultModelForEngine(engine);
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
      model,
      engine,
      parentRunId,
      threadId,
      // Slack runs work in a bare sandbox (no repo picker) and default to org memory.
      repos: [],
      // Staged inbound attachments — claimed atomically with run acceptance.
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      memoryScope,
      // Slack turns don't pin a skill yet.
      skillId: null,
      skillVersion: null,
      skillContentHash: null,
      // Slack turns are never native provider commands (a "/cmd" from Slack is prose).
      commandName: null,
      commandProvider: null,
      commandSessionId: null,
      commandCatalogRevision: null,
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
