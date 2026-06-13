/**
 * Slack Events-API ingest, adapted to the runs model. Given a verified
 * `event_callback` envelope plus the immutable identity captured by the durable
 * inbox, this decides whether the message is for us, stages inbound
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
import { env, slackConfig } from "../env";
import { runs, type MemoryScope, type RunStatus } from "../db/schema";
import { db } from "../db/client";
import { getRunForOrg } from "../runs/repo";
import {
  acceptRunCommand,
  preflightRunCommandReplay,
  RunAdmissionClosedError,
  type RunCommandIntent,
} from "../commands";
import { pumpThread } from "../worker";
import { stageInboundSlackFiles, type SlackInboundFileMeta } from "./inbound-files";
import { createSlackRunResponse, findOrAdoptSlackThread, linkSlackThread } from "./repo";
import { watchSlackRun } from "./watcher";
import {
  enqueueAddReactionTx,
  enqueuePostMessage,
  enqueueSessionStatusTx,
  enqueueStartStreamTx,
  enqueueThreadStatusTx,
  kickSlackOutbox,
} from "./outbox";
import { buildRunCard, deriveTitle, sessionUrl } from "./card";
import { parseRepoRef } from "../github/repo-ref";
import { directMessageChannel, openingStreamChunks } from "./streaming";
import { enqueueSlackTerminalDeliveryForRunTx } from "../runs/finalize";
import { eq } from "drizzle-orm";
import { defaultModelForEngine, isModelAllowedForEngine } from "../runs/model-policy";
import {
  isSlackSwitchableEngine,
  modelCatalogLine,
  parseSlackDirectives,
  resolveModelToken,
} from "./model-directive";
import { createRunResourceAuthorization } from "../resources/authorization";
import {
  legacyParentResources,
  resolveRunIntake,
  RunIntakeError,
  type RunResource,
} from "../resources/run-intake";
import { resolveSlackBotTokenForWorkspace } from "../integrations/slack-token-resolver";

/** Compatibility no-op: ingress dedupe now lives in the durable Slack inbox. */
export function resetSlackDeduperForTest(): void {
  // Intentionally empty.
}

const TERMINAL_STATUSES = new Set<RunStatus>(["completed", "failed"]);

async function healSlackRunDelivery(input: {
  runId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  /** The Slack user who asked - chat.startStream requires the recipient
   *  identity when streaming into a channel. */
  slackUserId?: string;
}): Promise<void> {
  let kickSlack = false;
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
    if (!run?.orgId) return;

    await createSlackRunResponse({
      runId: input.runId,
      teamId: input.teamId,
      channel: input.channel,
      threadTs: input.threadTs,
    }, tx);

    if (TERMINAL_STATUSES.has(run.status)) {
      kickSlack = (await enqueueSlackTerminalDeliveryForRunTx(
        tx,
        run,
        run.status,
        run.summary ?? "",
      )) || kickSlack;
    } else {
      const title = deriveTitle(run.prompt);
      const card = buildRunCard({
        title,
        phase: "queued",
        model: run.model,
        repoSpecs: run.repos.map(parseRepoRef),
        webUrl: sessionUrl(env.FRONTEND_ORIGIN, run.threadId),
      });
      const statusCreated = await enqueueSessionStatusTx(tx, {
        idempotencyKey: `slack-status:start:${input.teamId}:${input.runId}`,
        orgId: run.orgId,
        teamId: input.teamId,
        channel: input.channel,
        threadTs: input.threadTs,
        runId: input.runId,
        status: "processing",
      });
      const streamCreated = await enqueueStartStreamTx(tx, {
        idempotencyKey: `slack-stream:start:${input.teamId}:${input.runId}`,
        orgId: run.orgId,
        teamId: input.teamId,
        channel: input.channel,
        threadTs: input.threadTs,
        runId: input.runId,
        taskDisplayMode: "timeline",
        chunks: openingStreamChunks(title),
        recipientTeamId: input.teamId,
        recipientUserId: input.slackUserId,
        fallbackBlocks: card.blocks,
        fallbackText: card.text,
      });
      kickSlack = kickSlack || statusCreated || streamCreated;
      // Free-text shimmer while the run works - documented for DM assistant
      // threads only, so channel threads keep the enum session status above.
      if (directMessageChannel(input.channel)) {
        const shimmerCreated = await enqueueThreadStatusTx(tx, {
          idempotencyKey: `slack-thread-status:start:${input.teamId}:${input.runId}`,
          orgId: run.orgId,
          teamId: input.teamId,
          channel: input.channel,
          threadTs: input.threadTs,
          runId: input.runId,
          status: "is thinking...",
        });
        kickSlack = kickSlack || shimmerCreated;
      }
    }

    const reactionCreated = await enqueueAddReactionTx(tx, {
      idempotencyKey: `slack-ack:${input.teamId}:${input.channel}:${input.messageTs}`,
      orgId: run.orgId,
      teamId: input.teamId,
      channel: input.channel,
      timestamp: input.messageTs,
      name: "eyes",
    });
    kickSlack = kickSlack || reactionCreated;
  });
  if (kickSlack) kickSlackOutbox();
}

export interface SlackEnvelope {
  type?: string;
  challenge?: string;
  /** Slack's unique delivery id for the event (`Ev...`) — retries reuse it, so
   *  it is the durable dedupe identity (falls back to channel:ts). */
  event_id?: string;
  /** The workspace the event came from — resolved to an org via
   *  slack_workspaces; sender identity is resolved separately (fail closed). */
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

/** Pure transport-envelope gates that never need tenant identity or mutation. */
export function slackEventIsEarlyNoop(body: SlackEnvelope): boolean {
  const config = slackConfig();
  if (!config) return true;
  const event = body.event;
  const type = event?.type;
  if (!event || (type !== "app_mention" && type !== "message")) return true;
  if (event.bot_id) return true;
  const botUserId = botUserIdOf(body);
  if (botUserId && event.user === botUserId) return true;
  if (type === "message" && event.subtype && event.subtype !== "file_share") return true;
  const channel = event.channel;
  const ts = event.ts;
  if (!channel || !ts || !body.team_id) return true;
  if (config.channelAllowlist.size > 0 && !config.channelAllowlist.has(channel)) return true;
  if (event.channel_type === "im" || type !== "message") return false;
  const rawText = typeof event.text === "string" ? event.text : "";
  const isMention = botUserId ? rawText.includes(`<@${botUserId}>`) : false;
  const isThreadReply = Boolean(event.thread_ts && event.thread_ts !== ts);
  return isMention || !isThreadReply;
}

export interface SlackEventHandlingOptions {
  /** Immutable tenant identity captured before the transport ACK. */
  readonly identity: { readonly orgId: string; readonly actorId: string | null };
  /** null/undefined means file staging has not run; an array means reuse its
   * exact result so a close-vs-accept race never redownloads attachments. */
  readonly stagedAttachmentIds?: readonly string[] | null;
  /** Persist staging progress into the fenced inbox claim before acceptance. */
  readonly checkpointStagedAttachmentIds?: (ids: readonly string[]) => Promise<void>;
}

export type SlackEventOutcome =
  | { readonly status: "accepted"; readonly runId: string }
  | { readonly status: "replayed"; readonly runId: string }
  | { readonly status: "permanent_noop"; readonly reason: string }
  | { readonly status: "retryable_unavailable"; readonly reason: string }
  | { readonly status: "waiting_for_root"; readonly threadTs: string };

async function handleAdmissionClosed(input: {
  readonly error: RunAdmissionClosedError;
  readonly orgId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly ts: string;
  readonly threadTs: string;
}): Promise<SlackEventOutcome> {
  await enqueuePostMessage({
    idempotencyKey: `slack-admission-queued:${input.teamId}:${input.channel}:${input.ts}`,
    orgId: input.orgId,
    teamId: input.teamId,
    channel: input.channel,
    threadTs: input.threadTs,
    text: "Your request is queued during the deployment and will start automatically when service resumes.",
  });
  return { status: "retryable_unavailable", reason: input.error.code };
}

/**
 * Process one durably accepted inbox event. Transports invoke this only through
 * the inbox pump after persistence has succeeded and the ACK has been sent.
 */
export async function handleSlackEvent(
  body: SlackEnvelope,
  options: SlackEventHandlingOptions,
): Promise<SlackEventOutcome> {
  if (slackEventIsEarlyNoop(body)) {
    return { status: "permanent_noop", reason: "early_envelope_gate" };
  }
  const config = slackConfig();
  if (!config) return { status: "retryable_unavailable", reason: "slack_not_configured" };

  const event = body.event;
  const type = event?.type;
  if (!event || (type !== "app_mention" && type !== "message")) {
    return { status: "permanent_noop", reason: "unsupported_event" };
  }

  // Never react to bot-authored messages (loop guard) or non-plain message
  // subtypes (edits/deletes/joins — deferred). `file_share` is the one subtype
  // let through: it is how a plain message with attachments arrives.
  if (event.bot_id) return { status: "permanent_noop", reason: "bot_message" };
  const botUserId = botUserIdOf(body);
  if (botUserId && event.user === botUserId) {
    return { status: "permanent_noop", reason: "self_message" };
  }
  if (type === "message" && event.subtype && event.subtype !== "file_share") {
    return { status: "permanent_noop", reason: "unsupported_message_subtype" };
  }

  const channel = event.channel;
  const ts = event.ts;
  const teamId = body.team_id;
  if (!channel || !ts || !teamId) {
    return { status: "permanent_noop", reason: "missing_message_identity" };
  }

  // Operator channel allowlist: when set, ONLY events from listed channel ids
  // are processed (DMs included - a DM channel id is not in the list). Keeps a
  // freshly connected workspace scoped to a designated test channel until the
  // adapter is opened up.
  if (config.channelAllowlist.size > 0 && !config.channelAllowlist.has(channel)) {
    return { status: "permanent_noop", reason: "channel_not_allowed" };
  }

  const rawText = typeof event.text === "string" ? event.text : "";
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : undefined;
  const isDm = event.channel_type === "im";
  const isThreadReply = Boolean(threadTs && threadTs !== ts);
  const isMention = botUserId ? rawText.includes(`<@${botUserId}>`) : false;

  // Gating for non-DM plain `message` events.
  if (!isDm && type === "message") {
    if (isMention) return { status: "permanent_noop", reason: "paired_message_event" };
    if (!isThreadReply) return { status: "permanent_noop", reason: "untargeted_channel_message" };
  }

  const orgId = options.identity.orgId;
  const botToken = await resolveSlackBotTokenForWorkspace({
    orgId,
    teamId,
    config,
  });
  if (!botToken) return { status: "retryable_unavailable", reason: "bot_token_unavailable" };

  // A message threads under its thread root (replies) or under itself (top-level).
  const slackThreadTs = threadTs ?? ts;
  const link = await findOrAdoptSlackThread({
    teamId,
    channel,
    threadTs: slackThreadTs,
    orgId,
  });
  if (!isDm && type === "message" && isThreadReply && !link) {
    return { status: "waiting_for_root", threadTs: slackThreadTs };
  }

  // Workspace mapping establishes the tenant only. Every run also receives org
  // memory, provider access, and sandbox secrets, so an unmapped sender cannot
  // safely run even an apparently "org-only" prompt. Require the explicit
  // per-Slack-user mapping before dedupe or any durable work.
  const userId = options.identity.actorId;
  if (!userId) {
    await enqueuePostMessage({
      idempotencyKey: `slack-sender-guidance:${teamId}:${channel}:${ts}`,
      orgId,
      teamId,
      channel,
      threadTs: slackThreadTs,
      text: "Your Slack user is not linked to a product account. Ask an operator to add a SLACK_USER_BINDINGS mapping and retry.",
    });
    return { status: "permanent_noop", reason: "sender_not_linked" };
  }

  const durableKey = `slack-event:${teamId}:${channel}:${ts}`;
  const files = Array.isArray(event.files) ? event.files : [];

  let prompt = cleanPrompt(rawText, botUserId);
  if (!prompt) {
    // A files-only message still runs (the attachments ARE the request); an
    // empty message with no attached files stays a no-op.
    if (files.length === 0) {
      return { status: "permanent_noop", reason: "empty_message" };
    }
    prompt = "Review the attached files.";
  }

  // Threading: an existing Slack thread → reply under its root run (inherits the
  // useAgent thread); a new thread → a root run under its own id.
  let parentRunId: string | null = null;
  const runId = crypto.randomUUID();
  let threadId: string = runId;
  // Slack has no scope selector: a reply inherits its thread-root's scope, a new
  // thread defaults to "org". Personal scope is accepted only when the verified
  // per-Slack-user mapping matches the thread owner.
  let memoryScope: MemoryScope = "org";
  // A reply MUST run on the thread's original engine and model - engines keep
  // per-thread native session state in the sandbox, and a cross-engine turn
  // lands on a runtime shaped for a different provider (observed live: a codex
  // reply on an opencode-born thread failed its runtime readiness). Mirrors the
  // API reply path, which inherits the parent engine and refuses mismatches.
  let engine = config.defaultEngine;
  let model = config.model;
  let inheritedResources: readonly RunResource[] = [];
  let parent: Awaited<ReturnType<typeof getRunForOrg>> | null = null;
  if (link && isThreadReply) {
    parent = await getRunForOrg(orgId, link.rootRunId);
    if (parent) {
      parentRunId = parent.id;
      threadId = parent.threadId;
      memoryScope = parent.memoryScope;
      engine = parent.engine as typeof engine;
      model = parent.model;
      inheritedResources =
        parent.resolvedResources.length > 0
          ? parent.resolvedResources
          : legacyParentResources(parent.repos, "slack");
      if (
        memoryScope === "personal" &&
        parent.userId !== userId
      ) {
        await enqueuePostMessage({
          idempotencyKey: `slack-sender-guidance:${teamId}:${channel}:${ts}`,
          orgId,
          teamId,
          channel,
          threadTs: slackThreadTs,
          text: "This thread uses personal resources and your Slack user is not linked to its owner. Link the sender identity or start a new org-scoped thread.",
        });
        return { status: "permanent_noop", reason: "personal_thread_owner_mismatch" };
      }
    }
  }

  // In-message switching: `engine:x` / `model:y` tokens at the start of the
  // message. Model switches apply to any turn (same-engine model switching is
  // a supported provider capability); engine switches only start NEW threads -
  // an existing thread's engine owns its native session state.
  const { directives, rest } = parseSlackDirectives(prompt);
  const guide = (text: string) =>
    enqueuePostMessage({
      idempotencyKey: `slack-directive:${teamId}:${channel}:${ts}`,
      orgId,
      teamId,
      channel,
      text,
      threadTs: slackThreadTs,
    });
  if (directives.engine || directives.model) {
    if (rest) prompt = rest;
    else if (files.length === 0) {
      await guide("Include your request in the same message as the directive, e.g. `model:sol summarize this thread`.");
      return { status: "permanent_noop", reason: "directive_without_prompt" };
    }
    if (directives.engine) {
      if (!isSlackSwitchableEngine(directives.engine)) {
        await guide(`Unknown engine \`${directives.engine}\`. Available: opencode, claude, codex.`);
        return { status: "permanent_noop", reason: "unknown_engine_directive" };
      }
      if (parent && directives.engine !== engine) {
        await guide(`This thread runs on \`${engine}\` and cannot switch engines mid-thread. Start a new thread to use \`${directives.engine}\`.`);
        return { status: "permanent_noop", reason: "cross_engine_thread_switch" };
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
        return { status: "permanent_noop", reason: "unknown_model_directive" };
      }
      model = resolved;
    }
  }
  if (!isModelAllowedForEngine(engine, model)) {
    model = defaultModelForEngine(engine);
  }

  const attachmentIntentIds = files.slice(0, 5).map((file, index) =>
    file.id?.trim() || JSON.stringify([
      "slack-file",
      index,
      file.name ?? null,
      file.size ?? null,
      file.mimetype ?? null,
    ]),
  );
  const intent: RunCommandIntent = {
    prompt,
    model,
    engine,
    parentRunId,
    requestedRepos: [],
    requestedResources: [],
    attachmentIds: attachmentIntentIds,
    memoryScope,
    skillId: null,
    skillVersion: null,
    commandName: null,
    commandProvider: null,
    commandSessionId: null,
    commandCatalogRevision: null,
  };
  let replay;
  try {
    replay = await preflightRunCommandReplay({
      orgId,
      idempotencyKey: durableKey,
      intent,
    });
  } catch (error) {
    if (!(error instanceof RunAdmissionClosedError)) throw error;
    return handleAdmissionClosed({
      error,
      orgId,
      teamId,
      channel,
      ts,
      threadTs: slackThreadTs,
    });
  }
  if (replay) {
    if (replay.status === "replayed" && !link) {
      await linkSlackThread({
        channel,
        teamId,
        threadTs: slackThreadTs,
        rootRunId: replay.runId,
        orgId,
      });
      await healSlackRunDelivery({ runId: replay.runId, teamId, channel, threadTs: slackThreadTs, messageTs: ts, slackUserId: event.user });
    } else if (replay.status === "replayed") {
      await healSlackRunDelivery({ runId: replay.runId, teamId, channel, threadTs: slackThreadTs, messageTs: ts, slackUserId: event.user });
    }
    console.log(`[slack] duplicate event ignored (${replay.status}): ${durableKey}`);
    return replay.status === "replayed"
      ? { status: "replayed", runId: replay.runId }
      : {
          status: "permanent_noop",
          reason: replay.status === "conflict" ? `run_replay_${replay.reason}` : "unexpected_replay_state",
        };
  }

  // Only a first acceptance downloads and stages Slack files. A lost-response
  // retry above uses Slack's stable file identity and never touches the CDN.
  const attachmentIds = options.stagedAttachmentIds != null
    ? [...options.stagedAttachmentIds]
    : files.length > 0
      ? await stageInboundSlackFiles({ files, botToken, orgId, userId })
      : [];
  if (
    files.length > 0 &&
    options.stagedAttachmentIds == null &&
    options.checkpointStagedAttachmentIds
  ) {
    await options.checkpointStagedAttachmentIds(attachmentIds);
  }

  let resources: readonly RunResource[];
  let boundRepos: string[];
  try {
    const authorize = createRunResourceAuthorization(orgId);
    const intake = await resolveRunIntake(
      { source: "slack", text: prompt, inheritedResources },
      {
        authorize: async (resource) => {
          if (
            !userId &&
            (resource.kind === "code.repository" ||
              resource.kind === "code.change" ||
              resource.kind === "file")
          ) {
            return {
              available: false,
              message:
                "Your Slack user is not linked to a product account, so private resource access is blocked.",
            };
          }
          return await authorize(resource);
        },
      },
    );
    resources = intake.resources;
    boundRepos = [...intake.repos];
  } catch (error) {
    if (!(error instanceof RunIntakeError)) throw error;
    await enqueuePostMessage({
      idempotencyKey: `slack-resource-guidance:${teamId}:${channel}:${ts}`,
      orgId,
      teamId,
      channel,
      threadTs: slackThreadTs,
      text: `${error.diagnostic.message} ${error.diagnostic.action}`,
    });
    return { status: "permanent_noop", reason: "resource_intake_rejected" };
  }

  // Enter through the durable command lane keyed by the Slack MESSAGE identity
  // (team + channel + ts), so transport retries or two delivery IDs for the
  // same message still collapse to ONE run. The mailbox pump
  // preserves per-thread order: a reply in an active Slack thread waits for the
  // prior turn.
  let outcome;
  try {
    outcome = await acceptRunCommand({
      idempotencyKey: durableKey,
      orgId,
      actorId: userId,
      intent,
      run: {
        id: runId,
        prompt,
        model,
        engine,
        parentRunId,
        threadId,
        // Repositories the message links, VALIDATED against the offered set above
        // (mirrors the web composer). An unlinked message keeps the bare sandbox.
        repos: boundRepos,
        resolvedResources: resources,
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
  } catch (error) {
    if (!(error instanceof RunAdmissionClosedError)) throw error;
    return handleAdmissionClosed({
      error,
      orgId,
      teamId,
      channel,
      ts,
      threadTs: slackThreadTs,
    });
  }

  // A durable duplicate (the in-memory fast path missed it - restart or
  // cross-lane double delivery): the ORIGINAL acceptance stands. `replayed`
  // means an identical payload - heal a missing thread link (a crash between
  // acceptance and linking) and stop. `conflict` means the same external event
  // whose raw intent differs under the same external event identity. No second
  // ack fires either way: the receipt reaction is keyed slack-ack:<channel>:<ts>.
  if (outcome.status !== "created") {
    if (outcome.status === "replayed" && !link) {
      await linkSlackThread({ teamId, channel, threadTs: slackThreadTs, rootRunId: outcome.runId, orgId });
      await healSlackRunDelivery({ runId: outcome.runId, teamId, channel, threadTs: slackThreadTs, messageTs: ts, slackUserId: event.user });
    } else if (outcome.status === "replayed") {
      await healSlackRunDelivery({ runId: outcome.runId, teamId, channel, threadTs: slackThreadTs, messageTs: ts, slackUserId: event.user });
    }
    console.log(`[slack] duplicate event ignored (${outcome.status}): ${durableKey}`);
    return outcome.status === "replayed"
      ? { status: "replayed", runId: outcome.runId }
      : { status: "permanent_noop", reason: `run_accept_${outcome.reason}` };
  }

  // First bot interaction in this Slack thread → remember it as the root. Linked
  // BEFORE dispatch so run finalization (runs/finalize.ts) can always resolve the
  // Slack thread to enqueue the reply, even for a run that finishes near-instantly.
  if (!link) {
    await linkSlackThread({ teamId, channel, threadTs: slackThreadTs, rootRunId: runId, orgId });
  }
  await healSlackRunDelivery({ runId, teamId, channel, threadTs: slackThreadTs, messageTs: ts, slackUserId: event.user });

  await pumpThread(threadId);

  watchSlackRun({ runId, rootRunId: threadId, orgId, teamId, channel, threadTs: slackThreadTs });
  return { status: "accepted", runId };
}
