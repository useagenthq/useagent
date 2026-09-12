import type { ToolCallResult } from "./tools";
import { errorResult, textResult } from "./tool-results";
import { mintToolToken, type ToolTokenClaims } from "./token";
import { getRunForOrg } from "../../runs/repo";
import { persistedEngineModelReadyForDispatch } from "../../runs/engine-readiness";
import { sessionCapabilities } from "../../engines/capabilities";
import {
  childSessionEventLimit,
  childSessionLimit,
  createChildSession,
  gatherChildSessions,
  listChildSessionEvents,
  listChildSessions,
} from "../../runs/child-sessions";
import { acceptProductChildBatch } from "../../runs/child-thread-batch-service";
import { CHILD_BATCH_LIMIT, CHILD_PROMPT_MAX_CHARS, CHILD_TITLE_MAX_CHARS } from "../../runs/child-session-policy";
import { productChildThreadsEnabled } from "../../runs/thread-relationship-rollout";
import { composeHandoffPrompt, handoffsAvailable, recordBotHandoff, resolveBotMention } from "../../bots/handoffs";
import { botsEnabled } from "../../bots/rollout";
import { defaultModelForEngine } from "../../runs/model-policy";
import { ENGINE_IDS, type EngineId } from "../../db/schema";

const MAX_TEXT_EVENT_LINES = 20;
const MAX_TEXT_PAYLOAD_CHARS = 320;

export const CHILD_SESSION_TOOLS = [
  {
    name: "child_session_create",
    description:
      "Create one durable, independently dispatchable, messageable child thread. Identity, family, repositories, resources, and memory scope are derived from the signed current run. Creation is idempotent by idempotencyKey.",
    inputSchema: {
      type: "object",
      properties: {
        idempotencyKey: {
          type: "string",
          description:
            "Stable caller-chosen key for this child task within the current run.",
        },
        prompt: {
          type: "string",
          description: `Child task prompt, bounded to ${CHILD_PROMPT_MAX_CHARS} characters.`,
        },
        title: {
          type: "string",
          description: `Meaningful child title, bounded to ${CHILD_TITLE_MAX_CHARS} characters.`,
        },
      },
      required: ["idempotencyKey", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "child_session_create_many",
    description:
      "Atomically create 1-20 durable, independently dispatchable, messageable child threads for visible fan-out. All children inherit the signed parent authority snapshot and are accepted or rejected together.",
    inputSchema: {
      type: "object",
      properties: {
        idempotencyKey: { type: "string", description: "Stable key for this ordered fan-out batch." },
        children: {
          type: "array",
          minItems: 1,
          maxItems: CHILD_BATCH_LIMIT,
          items: {
            type: "object",
            properties: {
              title: { type: "string", maxLength: CHILD_TITLE_MAX_CHARS },
              prompt: { type: "string", maxLength: CHILD_PROMPT_MAX_CHARS },
              engine: { type: "string" },
              model: { type: "string" },
            },
            required: ["title", "prompt"],
            additionalProperties: false,
          },
        },
      },
      required: ["idempotencyKey", "children"],
      additionalProperties: false,
    },
  },
  {
    name: "child_session_list",
    description:
      "List durable child sessions for this live thread. Results are bounded and include event references for reconnect/reload inspection.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum child sessions to return.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "child_session_events",
    description:
      "Read a bounded page of durable native events for one child session in this live thread.",
    inputSchema: {
      type: "object",
      properties: {
        childRunId: {
          type: "string",
          description: "Child run id returned by child_session_create/list.",
        },
        cursor: {
          type: "integer",
          description:
            "Last native event seq already seen. Omit or use -1 for the first page.",
        },
        cursorRunId: {
          type: "string",
          description:
            "Run id returned as cursorRunId by the previous page. Required with cursor after a child thread advances to a later turn.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum native events to return.",
        },
      },
      required: ["childRunId"],
      additionalProperties: false,
    },
  },
  {
    name: "child_session_gather",
    description:
      "Gather a bounded status summary for durable child sessions in this live thread, returning event counts and references rather than full transcripts.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum child sessions to summarize.",
        },
      },
      additionalProperties: false,
    },
  },
] as const;

/** Agent-side @mention: hand part of the work to a named bot on that bot's own preset. */
export const BOT_HANDOFF_TOOL = {
  name: "bot_handoff",
  description:
    "Hand a task to another bot by name or id, like @mentioning it. Opens one durable delegated child thread on THAT bot's engine, model and standing rules (cross-harness is fine), linked under the current thread. Idempotent by idempotencyKey. Use child_session_gather to read its result.",
  inputSchema: {
    type: "object",
    properties: {
      idempotencyKey: { type: "string", description: "Stable key for this handoff; reuse it when retrying." },
      bot: { type: "string", description: "The bot's name (case-insensitive) or id." },
      prompt: { type: "string", description: `What you need from the bot, bounded to ${CHILD_PROMPT_MAX_CHARS} characters.` },
      title: { type: "string", description: `Short title for the handoff thread, bounded to ${CHILD_TITLE_MAX_CHARS} characters.` },
    },
    required: ["idempotencyKey", "bot", "prompt"],
  },
} as const;

export const CHILD_SESSION_TOOL_NAMES: ReadonlySet<string> = new Set(
  [...CHILD_SESSION_TOOLS.map((tool) => tool.name), BOT_HANDOFF_TOOL.name],
);

export function advertisedChildSessionTools(productChildren = productChildThreadsEnabled()): readonly ((typeof CHILD_SESSION_TOOLS)[number] | typeof BOT_HANDOFF_TOOL)[] {
  // The bots surface is org-flagged; the handoff tool is advertised only when
  // the flag is on globally (an allowlisted org still gets it at call time).
  if (productChildren) return botsEnabled(null) ? [...CHILD_SESSION_TOOLS, BOT_HANDOFF_TOOL] : CHILD_SESSION_TOOLS;
  return CHILD_SESSION_TOOLS
    .filter((tool) => tool.name !== "child_session_create_many")
    .map((tool) => tool.name === "child_session_create"
      ? {
          ...tool,
          description: "Create one durable legacy deferred child turn in the current thread. It starts after the current turn settles and is not an independently messageable product thread.",
        }
      : tool) as readonly (typeof CHILD_SESSION_TOOLS)[number][];
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, stableJsonValue(entry)]),
    );
  }
  return value;
}

function payloadPreview(payload: unknown): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const serialized = JSON.stringify(stableJsonValue(payload)) ?? "null";
  if (serialized.length <= MAX_TEXT_PAYLOAD_CHARS) {
    return { text: serialized, truncated: false };
  }
  let low = 0;
  let high = serialized.length;
  let text = JSON.stringify({ preview: "", truncated: true });
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({
      preview: serialized.slice(0, middle),
      truncated: true,
    });
    if (candidate.length <= MAX_TEXT_PAYLOAD_CHARS) {
      text = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return {
    text,
    truncated: true,
  };
}

export async function childSessionToolsEnabled(
  claims: ToolTokenClaims,
): Promise<boolean> {
  const run = await getRunForOrg(claims.orgId, claims.runId);
  if (!run || run.status !== "running") return false;
  // Gateway child sessions are engine-independent product commands. The rollout
  // decides whether creation uses legacy deferred turns or independently
  // dispatchable child threads; neither requires a provider-native session id.
  const capabilities = sessionCapabilities(run.engine, {
    desktop: Boolean(run.sandboxId),
    knowledgeTools: true,
  });
  return (
    capabilities.gatewayChildSessions &&
    (primaryApiOrigin() !== null || persistedEngineModelReadyForDispatch(run.engine, run.model))
  );
}

async function currentRun(claims: ToolTokenClaims) {
  const run = await getRunForOrg(claims.orgId, claims.runId);
  return run?.status === "running" ? run : null;
}

async function create(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const run = await currentRun(claims);
  if (!run || !(await childSessionToolsEnabled(claims))) {
    return errorResult(
      "Child sessions are not enabled for the current live run; they work on every engine but require an active live turn with a dispatch-ready engine and model.",
    );
  }
  const idempotencyKey = cleanString(args.idempotencyKey);
  const prompt = cleanString(args.prompt);
  const title = cleanString(args.title);
  if (!idempotencyKey)
    return errorResult("child_session_create requires idempotencyKey.");
  if (!prompt) return errorResult("child_session_create requires prompt.");
  if (prompt.length > CHILD_PROMPT_MAX_CHARS) {
    return errorResult(
      `child_session_create prompt exceeds ${CHILD_PROMPT_MAX_CHARS} characters.`,
    );
  }

  const outcome = await createChildSession({
    orgId: claims.orgId,
    actorId: claims.userId || null,
    parentRunId: run.id,
    threadId: run.threadId,
    prompt,
    title: title || undefined,
    engine: run.engine,
    model: run.model,
    repos: run.repos,
    memoryScope: run.memoryScope,
    idempotencyKey,
  });
  if (outcome.status === "conflict") {
    return errorResult(
      "idempotencyKey was already used for different child session input.",
    );
  }
  return textResult(
    `${outcome.status === "created" ? "Created" : "Replayed"} child session ${outcome.child.id} (${outcome.child.status}).`,
    { status: outcome.status, child: outcome.child },
  );
}

async function createMany(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const run = await currentRun(claims);
  if (!run || !(await childSessionToolsEnabled(claims)) || !productChildThreadsEnabled(claims.orgId)) {
    return errorResult("Product child fan-out is not enabled for the current live run.");
  }
  const idempotencyKey = cleanString(args.idempotencyKey);
  if (!idempotencyKey) return errorResult("child_session_create_many requires idempotencyKey.");
  if (!Array.isArray(args.children) || args.children.length < 1 || args.children.length > CHILD_BATCH_LIMIT) {
    return errorResult(`child_session_create_many requires 1 to ${CHILD_BATCH_LIMIT} children.`);
  }
  const children = args.children.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const child = value as Record<string, unknown>;
    const title = cleanString(child.title);
    const prompt = cleanString(child.prompt);
    const engine = cleanString(child.engine);
    const model = cleanString(child.model);
    if (!title || !prompt || (engine && !(ENGINE_IDS as readonly string[]).includes(engine))) return null;
    return {
      title,
      prompt,
      engine: (engine as EngineId) || null,
      model: model || null,
    };
  });
  if (children.some((child) => child === null)) return errorResult("invalid child_session_create_many child.");
  try {
    const outcome = await acceptProductChildBatch({
      orgId: claims.orgId,
      actorId: claims.userId || null,
      parentRunId: run.id,
      parentThreadId: run.threadId,
      idempotencyKey,
      children: children as Parameters<typeof acceptProductChildBatch>[0]["children"],
    });
    if (outcome.status === "conflict") return errorResult("idempotencyKey was already used for different fan-out input.");
    return textResult(
      `${outcome.status === "created" ? "Created" : "Replayed"} ${outcome.children.length} child threads.`,
      outcome,
    );
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : "child fan-out failed");
  }
}

async function list(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!(await childSessionToolsEnabled(claims))) {
    return errorResult(
      "Child sessions are not enabled for the current live run; they work on every engine but require an active live turn with a dispatch-ready engine and model.",
    );
  }
  const children = await listChildSessions({
    orgId: claims.orgId,
    threadId: claims.threadId,
    limit: args.limit,
  });
  return textResult(
    children.length === 0
      ? "No child sessions exist for this thread."
      : children
          .map(
            (child) =>
              `${child.id} ${child.status} ${child.eventRef} ${child.promptPreview}`,
          )
          .join("\n"),
    { children, limit: childSessionLimit(args.limit) },
  );
}

async function events(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!(await childSessionToolsEnabled(claims))) {
    return errorResult(
      "Child sessions are not enabled for the current live run.",
    );
  }
  const childRunId = cleanString(args.childRunId);
  if (!childRunId)
    return errorResult("child_session_events requires childRunId.");
  const page = await listChildSessionEvents({
    orgId: claims.orgId,
    threadId: claims.threadId,
    childRunId,
    cursor: args.cursor,
    cursorRunId: args.cursorRunId,
    limit: args.limit,
  });
  if (!page) return errorResult("child session not found", { status: 404 });
  const shownEvents = page.events.slice(0, MAX_TEXT_EVENT_LINES);
  const hasHiddenReturnedEvents = page.events.length > shownEvents.length;
  const more = hasHiddenReturnedEvents || page.hasMore;
  const textCursor = hasHiddenReturnedEvents
    ? shownEvents.at(-1)?.seq ?? null
    : page.nextCursor;
  const lines = shownEvents.map((event) => {
    const payload = payloadPreview(event.payload);
    return `seq=${event.seq} provider=${event.provider} event_type=${event.eventType} payload=${payload.text} payload_truncated=${payload.truncated}`;
  });
  return textResult(
    [
      `Child run: ${page.childRunId}`,
      `Returned: ${page.events.length}; shown: ${shownEvents.length}; more: ${more}; cursor: ${textCursor ?? "end"}; ref: ${page.eventRef}`,
      ...lines,
    ].join("\n"),
    { ...page, limit: childSessionEventLimit(args.limit) },
  );
}

async function gather(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!(await childSessionToolsEnabled(claims))) {
    return errorResult(
      "Child sessions are not enabled for the current live run.",
    );
  }
  const children = await gatherChildSessions({
    orgId: claims.orgId,
    threadId: claims.threadId,
    limit: args.limit,
  });
  return textResult(
    children.length === 0
      ? "No child sessions exist for this thread."
      : children
          .map(
            (child) =>
              `${child.id} ${child.status} events=${child.eventCount} ref=${child.eventRef}`,
          )
          .join("\n"),
    { children, limit: childSessionLimit(args.limit) },
  );
}

async function handoff(claims: ToolTokenClaims, args: Record<string, unknown>): Promise<ToolCallResult> {
  const run = await currentRun(claims);
  if (!run || !(await childSessionToolsEnabled(claims))) {
    return errorResult("Handoffs require an active live turn with a dispatch-ready engine and model.");
  }
  if (!handoffsAvailable(claims.orgId)) {
    return errorResult("Bot handoffs need the bots surface and product child threads enabled for this organization.");
  }
  const idempotencyKey = cleanString(args.idempotencyKey);
  const mention = cleanString(args.bot);
  const prompt = cleanString(args.prompt);
  const title = cleanString(args.title);
  if (!idempotencyKey) return errorResult("bot_handoff requires idempotencyKey.");
  if (!mention) return errorResult("bot_handoff requires bot (name or id).");
  if (!prompt) return errorResult("bot_handoff requires prompt.");
  if (prompt.length > CHILD_PROMPT_MAX_CHARS) return errorResult(`bot_handoff prompt exceeds ${CHILD_PROMPT_MAX_CHARS} characters.`);
  const bot = await resolveBotMention(claims.orgId, mention);
  if (!bot) return errorResult(`No bot named ${mention}. Bots are listed in the workspace's Bots page.`);
  const outcome = await createChildSession({
    orgId: claims.orgId,
    actorId: claims.userId || null,
    parentRunId: run.id,
    threadId: run.threadId,
    prompt: composeHandoffPrompt(bot, prompt),
    title: title || `${bot.name}: ${prompt.slice(0, 120)}`,
    engine: bot.engine,
    model: bot.model ?? defaultModelForEngine(bot.engine),
    repos: [...bot.repos],
    memoryScope: bot.memoryScope,
    idempotencyKey: `${idempotencyKey}:${bot.id}`,
  });
  if (outcome.status === "conflict") return errorResult("idempotencyKey was already used for a different handoff.");
  await recordBotHandoff({ orgId: claims.orgId, botId: bot.id, threadId: outcome.child.id, parentThreadId: run.threadId, sourceRunId: run.id });
  return textResult(
    `${outcome.status === "created" ? "Handed off to" : "Replayed handoff to"} ${bot.name} in child session ${outcome.child.id} (${outcome.child.status}).`,
    { status: outcome.status, bot: { id: bot.id, name: bot.name, engine: bot.engine }, child: outcome.child },
  );
}

export async function executeChildSessionToolLocal(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (name === "child_session_create") return create(claims, args);
  if (name === "child_session_create_many") return createMany(claims, args);
  if (name === "child_session_list") return list(claims, args);
  if (name === "child_session_events") return events(claims, args);
  if (name === "child_session_gather") return gather(claims, args);
  if (name === BOT_HANDOFF_TOOL.name) return handoff(claims, args);
  return errorResult(`Unknown tool: ${name}`);
}

function primaryApiOrigin(): string | null {
  if (!process.env.GATEWAY_DATABASE_URL) return null;
  const raw = process.env.USEAGENT_API_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function executeThroughPrimaryApi(
  origin: string,
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const remainingTtlMs = Math.max(1, Math.min(30_000, claims.exp - Date.now()));
  const token = mintToolToken(
    {
      orgId: claims.orgId,
      userId: claims.userId,
      threadId: claims.threadId,
      runId: claims.runId,
      scope: claims.scope,
    },
    remainingTtlMs,
  );
  const response = await fetch(`${origin}/api/internal/child-sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => null)) as
    | { result?: ToolCallResult; error?: string }
    | null;
  if (!response.ok || !body?.result) {
    return errorResult(
      body?.error ?? `child-session control plane returned HTTP ${response.status}`,
      { status: response.status },
    );
  }
  return body.result;
}

/**
 * The standalone gateway runs with a restricted database role that can read
 * runs but never INSERT runs/run_commands/run_admissions - exactly what
 * creating a child session does. Mirror the automation/approval seam: in
 * gateway mode every child-session operation is delegated to the loopback
 * primary API under a freshly minted, short-lived copy of the current live
 * capability; the primary re-verifies liveness and tenant identity before
 * executing. In-backend (non-gateway) mode keeps the direct path.
 */
export async function executeChildSessionTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const origin = primaryApiOrigin();
  if (process.env.GATEWAY_DATABASE_URL && !origin) {
    return errorResult(
      "child-session control plane is not configured; ask the workspace operator to set USEAGENT_API_ORIGIN for the gateway, then retry",
    );
  }
  return origin
    ? executeThroughPrimaryApi(origin, claims, name, args)
    : executeChildSessionToolLocal(claims, name, args);
}
