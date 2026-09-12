import { Hono, type Context } from "hono";
import { latestRunInThread } from "../../bots/repo";
import type { AppEnv } from "../../http";
import { orgScope } from "../../middleware/org";
import { getRunForOrg } from "../../runs/repo";
import { handleRunCreate } from "../../runs/routes";
import {
  consumeApprovalCapability,
  mintApprovalCapability,
} from "./approval-capability";
import {
  approvalDecisionPrompt,
  approvalRequestSummary,
  approveApprovalRequest,
  denyApprovalRequest,
  listApprovalRequests,
  type ApprovalFollowUpInput,
  type ApprovalFollowUpOutcome,
  type ApprovalResolutionError,
} from "./approval-requests";
import { gatewayToolRequiresApproval } from "./operation-registry";
import { resolveToolRunIdentity } from "./run-authorization";
import { verifyToolToken } from "./token";

const MAX_INTERNAL_BODY_BYTES = 128 * 1024;

interface ApprovableRun {
  readonly id: string;
  readonly userId: string | null;
  readonly threadId: string;
  readonly status: string;
}

interface ApprovalRouteDependencies {
  readonly findRun: (orgId: string, runId: string) => Promise<ApprovableRun | null>;
  readonly requiresApproval: (toolName: string) => boolean;
  readonly mint: typeof mintApprovalCapability;
}

const defaultDependencies: ApprovalRouteDependencies = {
  findRun: getRunForOrg,
  requiresApproval: gatewayToolRequiresApproval,
  mint: mintApprovalCapability,
};

class ApprovalRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(code);
    this.name = "ApprovalRequestError";
  }
}

function requiredString(value: unknown, field: string): string {
  const parsed = typeof value === "string" ? value.trim() : "";
  if (!parsed) throw new ApprovalRequestError(`invalid_${field}`, 400);
  return parsed;
}

function argumentsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApprovalRequestError("invalid_arguments", 400);
  }
  const args = value as Record<string, unknown>;
  if ("approvalCapability" in args) {
    throw new ApprovalRequestError("approval_capability_must_be_omitted", 400);
  }
  return args;
}

export async function issueGatewayOperationApproval(
  identity: { readonly orgId: string; readonly userId: string | null },
  body: unknown,
  dependencies: ApprovalRouteDependencies = defaultDependencies,
): Promise<{
  readonly capability: string;
  readonly expires_at: string;
  readonly tool_name: string;
  readonly arguments_hash: string;
}> {
  if (!identity.userId) throw new ApprovalRequestError("user_required", 403);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApprovalRequestError("invalid_request", 400);
  }
  const input = body as Record<string, unknown>;
  const runId = requiredString(input.runId, "run_id");
  const toolName = requiredString(input.toolName, "tool_name");
  const args = argumentsRecord(input.arguments);
  if (!dependencies.requiresApproval(toolName)) {
    throw new ApprovalRequestError("tool_does_not_accept_approval", 400);
  }

  const run = await dependencies.findRun(identity.orgId, runId);
  if (!run) throw new ApprovalRequestError("run_not_found", 404);
  if (run.status !== "running") throw new ApprovalRequestError("run_not_active", 409);
  if (run.userId !== identity.userId) {
    throw new ApprovalRequestError("run_user_mismatch", 403);
  }

  const minted = await dependencies.mint({
    orgId: identity.orgId,
    userId: identity.userId,
    threadId: run.threadId,
    runId: run.id,
    toolName,
    arguments: args,
  });
  return {
    capability: minted.capability,
    expires_at: minted.expiresAt.toISOString(),
    tool_name: toolName,
    arguments_hash: minted.argumentsHash,
  };
}

function resolutionErrorStatus(error: ApprovalResolutionError): 403 | 404 | 409 | 502 {
  if (error === "request_not_found" || error === "run_not_found") return 404;
  if (error === "run_user_mismatch") return 403;
  if (error === "follow_up_failed") return 502;
  return 409;
}

const DENY_REASON_MAX = 500;

/** `{ reason }` on a deny; a body-less POST (the approve path, older clients) reads as none. */
async function decisionReason(c: Context<AppEnv>): Promise<string | null> {
  const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, DENY_REASON_MAX) : "";
  return reason || null;
}

/**
 * The decision reaches a settled run's thread the way a bot message does: a
 * follow-up turn chained under the thread head through the run-create door
 * (`handleRunCreate` with `parent_run_id`), owned by the person who decided.
 */
async function startDecisionFollowUp(
  c: Context<AppEnv>,
  input: ApprovalFollowUpInput,
): Promise<ApprovalFollowUpOutcome> {
  const head = await latestRunInThread(c.get("orgId"), input.request.threadId);
  if (!head) return { error: "thread_not_found" };
  const response = await handleRunCreate(c, {
    body: {
      prompt: approvalDecisionPrompt(input.request, input.decision, input.reason),
      parent_run_id: head.id,
    },
  });
  const body = (await response.json().catch(() => null)) as { id?: unknown; error?: unknown } | null;
  if (response.status === 201 && typeof body?.id === "string") return { runId: body.id };
  return { error: typeof body?.error === "string" ? body.error : `run_create_${response.status}` };
}

export function createGatewayApprovalRoutes(
  dependencies: ApprovalRouteDependencies = defaultDependencies,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("*", orgScope);
  routes.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    try {
      return c.json(
        await issueGatewayOperationApproval(
          { orgId: c.get("orgId"), userId: c.get("userId") },
          body,
          dependencies,
        ),
        201,
      );
    } catch (error) {
      if (error instanceof ApprovalRequestError) {
        return c.json({ error: error.code }, error.status);
      }
      throw error;
    }
  });

  // Mid-run approval-request lane (#77): the human side of approval_request /
  // approval_poll. Same boundary as the mint route above - an org member's
  // session, and resolution additionally requires the target run to be live or
  // settled (a settled run's thread gets a follow-up turn carrying the
  // decision) and to belong to that member. The parked capability is never
  // exposed here; it reaches only the consuming run through approval_poll.
  // Resolved requests are served alongside pending ones (status, resolved_by,
  // resolved_at) so a reloaded thread still shows what was approved or denied
  // and by whom; `?status=pending` narrows to the actionable set.
  routes.get("/requests", async (c) => {
    const runId = c.req.query("runId")?.trim() ?? "";
    const threadId = c.req.query("threadId")?.trim() ?? "";
    if (!runId && !threadId) return c.json({ error: "run_or_thread_required" }, 400);
    const status = c.req.query("status")?.trim();
    if (status && status !== "pending") return c.json({ error: "invalid_status" }, 400);
    const requests = await listApprovalRequests({
      orgId: c.get("orgId"),
      ...(runId ? { runId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(status === "pending" ? { status } : {}),
    });
    return c.json({ requests: requests.map(approvalRequestSummary) });
  });

  const resolveRequest = async (c: Context<AppEnv>, decision: "approve" | "deny") => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    const input = { orgId: c.get("orgId"), requestId: c.req.param("id") ?? "" };
    const serviceDependencies = {
      findRun: dependencies.findRun,
      mint: dependencies.mint,
      startFollowUp: (followUp: ApprovalFollowUpInput) => startDecisionFollowUp(c, followUp),
    };
    const result =
      decision === "approve"
        ? await approveApprovalRequest(
            { ...input, approvedBy: userId },
            serviceDependencies,
          )
        : await denyApprovalRequest(
            { ...input, deniedBy: userId, reason: await decisionReason(c) },
            serviceDependencies,
          );
    if (!result.ok) {
      return c.json(
        { error: result.error, ...(result.detail ? { detail: result.detail } : {}) },
        resolutionErrorStatus(result.error),
      );
    }
    return c.json({
      id: result.request.id,
      status: result.request.status,
      ...(result.followUpRunId ? { follow_up_run_id: result.followUpRunId } : {}),
    });
  };

  routes.post("/requests/:id/approve", (c) => resolveRequest(c, "approve"));
  routes.post("/requests/:id/deny", (c) => resolveRequest(c, "deny"));
  return routes;
}

export const gatewayApprovalRoutes = createGatewayApprovalRoutes();

function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

/** Self-authenticated bridge from the restricted public gateway to the primary DB owner. */
export const internalGatewayApprovalRoutes = new Hono();

internalGatewayApprovalRoutes.post("/", async (c) => {
  const claims = verifyToolToken(bearer(c.req.header("authorization")));
  if (!claims) return c.json({ error: "unauthorized" }, 401);
  const current = await resolveToolRunIdentity(claims).catch(() => null);
  if (!current) return c.json({ error: "inactive_capability" }, 403);

  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_INTERNAL_BODY_BYTES) {
    return c.json({ error: "request_too_large" }, 413);
  }
  let body: unknown;
  try {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_INTERNAL_BODY_BYTES) {
      return c.json({ error: "request_too_large" }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const input = body as Record<string, unknown>;
  const toolName = typeof input.toolName === "string" ? input.toolName : "";
  const args = input.arguments;
  if (!gatewayToolRequiresApproval(toolName)) {
    return c.json({ error: "tool_does_not_accept_approval" }, 400);
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return c.json({ error: "invalid_arguments" }, 400);
  }
  const operationArgs = args as Record<string, unknown>;
  const approved = await consumeApprovalCapability({
    capability:
      typeof operationArgs.approvalCapability === "string"
        ? operationArgs.approvalCapability
        : null,
    claims: current,
    toolName,
    arguments: operationArgs,
  });
  return c.json({ approved });
});
