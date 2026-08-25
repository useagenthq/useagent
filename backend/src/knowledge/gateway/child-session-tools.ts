import type { ToolCallResult } from "./tools";
import { errorResult, textResult } from "./tool-results";
import { mintToolToken, type ToolTokenClaims } from "./token";
import { getRunForOrg } from "../../runs/repo";
import { engineModelReadyForDispatch } from "../../runs/engine-readiness";
import { sessionCapabilities } from "../../engines/capabilities";
import {
  childSessionEventLimit,
  childSessionLimit,
  createChildSession,
  gatherChildSessions,
  listChildSessionEvents,
  listChildSessions,
} from "../../runs/child-sessions";

const MAX_PROMPT_CHARS = 4_000;
const MAX_TEXT_EVENT_LINES = 20;
const MAX_TEXT_PAYLOAD_CHARS = 320;

export const CHILD_SESSION_TOOLS = [
  {
    name: "child_session_create",
    description:
      "Create a durable child session under the current live run. Children do NOT run in parallel with this turn: each child is queued as a deferred serial thread turn that starts only after the current turn settles, so plan to finish this turn and read child results in a later turn (via child_session_list/events/gather). Identity, thread, engine, model, repositories, and memory scope are derived only from the signed gateway capability and current run. Creation is idempotent by idempotencyKey.",
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
          description: `Child task prompt, bounded to ${MAX_PROMPT_CHARS} characters.`,
        },
      },
      required: ["idempotencyKey", "prompt"],
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

export const CHILD_SESSION_TOOL_NAMES: ReadonlySet<string> = new Set(
  CHILD_SESSION_TOOLS.map((tool) => tool.name),
);

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
  // Gateway child sessions are engine-independent (deferred serial thread turns through the
  // product command lane), so no runtime-session-id requirement: any live run on a
  // dispatch-ready engine/model gets them, ACP claude/codex included.
  const capabilities = sessionCapabilities(run.engine, {
    desktop: Boolean(run.sandboxId),
    knowledgeTools: true,
  });
  return (
    capabilities.gatewayChildSessions &&
    engineModelReadyForDispatch(run.engine, run.model)
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
  if (!idempotencyKey)
    return errorResult("child_session_create requires idempotencyKey.");
  if (!prompt) return errorResult("child_session_create requires prompt.");
  if (prompt.length > MAX_PROMPT_CHARS) {
    return errorResult(
      `child_session_create prompt exceeds ${MAX_PROMPT_CHARS} characters.`,
    );
  }

  const outcome = await createChildSession({
    orgId: claims.orgId,
    actorId: claims.userId || null,
    parentRunId: run.id,
    threadId: run.threadId,
    prompt,
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
    limit: args.limit,
  });
  if (!page) return errorResult("child session not found", { status: 404 });
  const shownEvents = page.events.slice(0, MAX_TEXT_EVENT_LINES);
  const hasHiddenReturnedEvents = page.events.length > shownEvents.length;
  const more = hasHiddenReturnedEvents || page.nextCursor !== null;
  const textCursor = hasHiddenReturnedEvents
    ? shownEvents.at(-1)?.seq ?? null
    : page.nextCursor;
  const lines = shownEvents.map((event) => {
    const payload = payloadPreview(event.payload);
    return `seq=${event.seq} provider=${event.provider} event_type=${event.eventType} payload=${payload.text} payload_truncated=${payload.truncated}`;
  });
  return textResult(
    [
      `Child run: ${childRunId}`,
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

export async function executeChildSessionToolLocal(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (name === "child_session_create") return create(claims, args);
  if (name === "child_session_list") return list(claims, args);
  if (name === "child_session_events") return events(claims, args);
  if (name === "child_session_gather") return gather(claims, args);
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
