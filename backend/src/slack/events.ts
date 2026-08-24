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
import { resolveSlackSender, resolveSlackWorkspace } from "./workspaces";
import {
  enqueueAddReactionTx,
  enqueuePostMessage,
  enqueueSessionStatusTx,
  enqueueStartStreamTx,
  kickSlackOutbox,
} from "./outbox";
import { buildRunCard, deriveTitle, sessionUrl } from "./card";
import { parseRepoRef } from "../github/repo-ref";
import { openingStreamChunks } from "./streaming";
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

let deduper = createDeduper();

/** TEST ONLY: drop all in-memory dedupe state, simulating a process restart so
 *  suites can prove the DURABLE dedupe (the command-lane idempotency key). */
export function resetSlackDeduperForTest(): void {
  deduper = createDeduper();
}

const TERMINAL_STATUSES = new Set<RunStatus>(["completed", "failed"]);

async function healSlackRunDelivery(input: {
  runId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  messageTs: string;
}): Promise<void> {
  let kickSlack = false;
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
    if (!run) return;

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
        teamId: input.teamId,
        channel: input.channel,
        threadTs: input.threadTs,
        status: "processing",
      });
      const streamCreated = await enqueueStartStreamTx(tx, {
        idempotencyKey: `slack-stream:start:${input.teamId}:${input.runId}`,
        teamId: input.teamId,
        channel: input.channel,
        threadTs: input.threadTs,
        runId: input.runId,
        taskDisplayMode: "task_update",
        chunks: openingStreamChunks({ title, mode: "task_update" }),
        fallbackBlocks: card.blocks,
        fallbackText: card.text,
      });
      kickSlack = kickSlack || statusCreated || streamCreated;
    }

    const reactionCreated = await enqueueAddReactionTx(tx, {
      idempotencyKey: `slack-ack:${input.teamId}:${input.channel}:${input.messageTs}`,
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
  const teamId = body.team_id;
  if (!channel || !ts || !teamId) return;

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

  // Gating for non-DM plain `message` events.
  if (!isDm && type === "message") {
    if (isMention) return; // the paired app_mention handles it
    if (!isThreadReply) return; // untargeted channel chatter
  }

  // Workspace identity — FAIL CLOSED. An event from a workspace with no
  // slack_workspaces mapping is ignored (logged once per team id); nothing ever
  // falls back to a seeded org. Resolved BEFORE dedupe so an unmapped
  // workspace's event never reserves a dedupe key (a retry after the operator
  // adds the mapping still lands).
  const workspace = await resolveSlackWorkspace(teamId);
  if (!workspace) return;
  const botToken = await resolveSlackBotTokenForWorkspace({
    orgId: workspace.orgId,
    teamId,
    config,
  });
  if (!botToken) return;

  // A message threads under its thread root (replies) or under itself (top-level).
  const slackThreadTs = threadTs ?? ts;
  const link = await findOrAdoptSlackThread({
    teamId,
    channel,
    threadTs: slackThreadTs,
    orgId: workspace.orgId,
  });
  if (!isDm && type === "message" && isThreadReply && !link) return;

  // Workspace mapping establishes the tenant only. Every run also receives org
  // memory, provider access, and sandbox secrets, so an unmapped sender cannot
  // safely run even an apparently "org-only" prompt. Require the explicit
  // per-Slack-user mapping before dedupe or any durable work.
  const sender = await resolveSlackSender(workspace, teamId, event.user);
  if (!sender) {
    await enqueuePostMessage({
      idempotencyKey: `slack-sender-guidance:${teamId}:${channel}:${ts}`,
      teamId,
      channel,
      threadTs: slackThreadTs,
      text: "Your Slack user is not linked to a product account. Ask an operator to add a SLACK_USER_BINDINGS mapping and retry.",
    });
    return;
  }

  // Dedupe last, so a genuinely-ours message reserves its key exactly once.
  const key = `${teamId}:${channel}:${ts}`;
  if (deduper.seen(key)) return;

  const orgId = workspace.orgId;
  const userId = sender.userId;

  const durableKey = body.event_id
    ? `slack-event:${teamId}:${body.event_id}`
    : `slack-event:${teamId}:${channel}:${ts}`;
  const files = Array.isArray(event.files) ? event.files : [];

  let prompt = cleanPrompt(rawText, botUserId);
  if (!prompt) {
    // A files-only message still runs (the attachments ARE the request); an
    // empty message with no attached files stays a no-op.
    if (files.length === 0) {
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
          teamId,
          channel,
          threadTs: slackThreadTs,
          text: "This thread uses personal resources and your Slack user is not linked to its owner. Link the sender identity or start a new org-scoped thread.",
        });
        return;
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
      teamId,
      channel,
      text,
      threadTs: slackThreadTs,
    });
  if (directives.engine || directives.model) {
    if (rest) prompt = rest;
    else if (files.length === 0) {
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
    deduper.forget(key);
    await enqueuePostMessage({
      idempotencyKey: `slack-admission-guidance:${teamId}:${channel}:${ts}`,
      teamId,
      channel,
      threadTs: slackThreadTs,
      text: "New runs are temporarily paused for a deployment. Retry this message shortly.",
    });
    return;
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
      await healSlackRunDelivery({ runId: replay.runId, teamId, channel, threadTs: slackThreadTs, messageTs: ts });
    } else if (replay.status === "replayed") {
      await healSlackRunDelivery({ runId: replay.runId, teamId, channel, threadTs: slackThreadTs, messageTs: ts });
    }
    console.log(`[slack] duplicate event ignored (${replay.status}): ${durableKey}`);
    return;
  }

  // Only a first acceptance downloads and stages Slack files. A lost-response
  // retry above uses Slack's stable file identity and never touches the CDN.
  const attachmentIds = files.length > 0
    ? await stageInboundSlackFiles({ files, botToken, orgId, userId })
    : [];

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
      teamId,
      channel,
      threadTs: slackThreadTs,
      text: `${error.diagnostic.message} ${error.diagnostic.action}`,
    });
    return;
  }

  // Enter through the durable command lane keyed by the SLACK EVENT IDENTITY
  // (event_id when present - retries reuse it - else channel:ts), so a
  // duplicate delivery that outlives the in-memory deduper (restart, cross-lane
  // HTTP+socket double delivery) still collapses to ONE run. The mailbox pump
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
    deduper.forget(key);
    await enqueuePostMessage({
      idempotencyKey: `slack-admission-guidance:${teamId}:${channel}:${ts}`,
      teamId,
      channel,
      threadTs: slackThreadTs,
      text: "New runs are temporarily paused for a deployment. Retry this message shortly.",
    });
    return;
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
      await healSlackRunDelivery({ runId: outcome.runId, teamId, channel, threadTs: slackThreadTs, messageTs: ts });
    } else if (outcome.status === "replayed") {
      await healSlackRunDelivery({ runId: outcome.runId, teamId, channel, threadTs: slackThreadTs, messageTs: ts });
    }
    console.log(`[slack] duplicate event ignored (${outcome.status}): ${durableKey}`);
    return;
  }

  // First bot interaction in this Slack thread → remember it as the root. Linked
  // BEFORE dispatch so run finalization (runs/finalize.ts) can always resolve the
  // Slack thread to enqueue the reply, even for a run that finishes near-instantly.
  if (!link) {
    await linkSlackThread({ teamId, channel, threadTs: slackThreadTs, rootRunId: runId, orgId });
  }
  await healSlackRunDelivery({ runId, teamId, channel, threadTs: slackThreadTs, messageTs: ts });

  await pumpThread(threadId);

  watchSlackRun({ runId, rootRunId: threadId, teamId, channel, threadTs: slackThreadTs });
}
