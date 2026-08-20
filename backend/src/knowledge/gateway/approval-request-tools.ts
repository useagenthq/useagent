import { Hono } from "hono";
import type { GatewayToolDescriptor } from "./descriptor";
import {
  createApprovalRequest,
  getApprovalRequestForOrg,
  takeApprovalCapability,
} from "./approval-requests";
import { resolveToolRunIdentity } from "./run-authorization";
import { errorResult, textResult } from "./tool-results";
import { mintToolToken, verifyToolToken, type ToolTokenClaims } from "./token";
import type { ToolCallResult } from "./tools";

// ---------------------------------------------------------------------------
// Mid-run approval experience (#77). Approval-gated gateway tools refuse with
// `approval_required` because a run can never mint its own capability. These
// two tools close the loop from inside the run:
//   approval_request - record a durable, human-visible approval request for
//     one exact gated operation and tell the agent to hand off to the user.
//   approval_poll    - fetch the decision; an approval delivers the one-shot
//     capability EXACTLY once, after which the agent retries the gated tool
//     with `approvalCapability`.
// Approval state lives on the primary backend. In the restricted standalone
// gateway process these tools delegate to the loopback primary API under the
// current run capability (same shape as automation tools).
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 128 * 1024;

export const APPROVAL_REQUEST_TOOLS: readonly GatewayToolDescriptor[] = [
  {
    name: "approval_request",
    description:
      "Ask the human user to approve one approval-gated gateway operation (a tool that refused with approval_required). Records a durable approval request bound to this run and the exact tool arguments, and surfaces it in the session view. Returns the request id as pending: tell the user to approve or deny it in the Skynet session view, then check the decision with approval_poll.",
    inputSchema: {
      type: "object",
      properties: {
        toolName: {
          type: "string",
          description: "Exact gateway tool name that requires approval, for example automation_delete.",
        },
        arguments: {
          type: "object",
          description:
            "The complete argument object you will pass to the gated tool, without approvalCapability. The approval binds to these exact arguments; changing them later invalidates it.",
          additionalProperties: true,
        },
      },
      required: ["toolName", "arguments"],
      additionalProperties: false,
    },
  },
  {
    name: "approval_poll",
    description:
      "Check the decision on one approval request created by approval_request. While pending, remind the user and poll again after a short wait. When approved it returns the one-shot approvalCapability exactly once; immediately retry the gated tool with the same arguments plus that approvalCapability.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Approval request id returned by approval_request." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

export const APPROVAL_REQUEST_TOOL_NAMES: ReadonlySet<string> = new Set(
  APPROVAL_REQUEST_TOOLS.map((tool) => tool.name),
);

function schemaRequirements(descriptor: GatewayToolDescriptor): readonly string[] {
  const schema = descriptor.inputSchema as { readonly required?: readonly string[] };
  return (schema.required ?? []).filter((field) => field !== "approvalCapability");
}

async function requestApproval(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const toolName = typeof args.toolName === "string" ? args.toolName.trim() : "";
  if (!toolName) return errorResult("approval_request requires the gated tool's exact name.");
  const rawArguments = args.arguments;
  if (!rawArguments || typeof rawArguments !== "object" || Array.isArray(rawArguments)) {
    return errorResult("approval_request requires the gated tool's argument object.");
  }
  const operationArguments = rawArguments as Record<string, unknown>;
  if ("approvalCapability" in operationArguments) {
    return errorResult(
      "Omit approvalCapability from the arguments: the approval itself produces it.",
    );
  }
  // Runtime import: the registry statically registers these tools, so a static
  // import back into it would be a module cycle.
  const registry = await import("./operation-registry");
  if (!registry.gatewayToolRequiresApproval(toolName)) {
    return errorResult(
      `${toolName} does not require approval. Call it directly instead of requesting approval.`,
    );
  }
  const descriptor = registry.advertisedGatewayToolDescriptor(toolName);
  const missing = descriptor
    ? schemaRequirements(descriptor).filter((field) => !(field in operationArguments))
    : [];
  if (missing.length > 0) {
    return errorResult(
      `approval_request needs the complete ${toolName} arguments; missing: ${missing.join(", ")}. The approval binds to the exact argument object.`,
    );
  }

  const { request, created } = await createApprovalRequest({
    orgId: claims.orgId,
    runId: claims.runId,
    threadId: claims.threadId,
    toolName,
    arguments: operationArguments,
  });
  return textResult(
    `Approval request ${request.id} for ${toolName} is pending. Tell the user to approve or deny it in the Skynet session view, then check the decision with approval_poll using this id.`,
    {
      approval_request_id: request.id,
      tool_name: request.toolName,
      status: request.status,
      expires_at: request.expiresAt.toISOString(),
      already_pending: !created,
    },
  );
}

async function pollApproval(
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return errorResult("approval_poll requires an approval request id.");
  const request = await getApprovalRequestForOrg(claims.orgId, id);
  if (!request) return errorResult("approval request not found", { status: 404 });
  if (request.runId !== claims.runId) {
    return errorResult(
      "This approval request belongs to a different run; its capability is not usable here.",
      { error: "approval_request_run_mismatch" },
    );
  }
  if (request.status === "pending") {
    return textResult(
      "Still pending. Remind the user to approve or deny this request in the Skynet session view, wait briefly, and poll again.",
      { approval_request_id: request.id, status: "pending" },
    );
  }
  if (request.status === "denied") {
    return textResult(
      "The user denied this request. Do not retry the operation; continue without it or ask the user how to proceed.",
      { approval_request_id: request.id, status: "denied" },
    );
  }
  if (request.status === "expired") {
    return textResult(
      "This approval request expired without a decision. If the operation is still needed, submit a new approval_request.",
      { approval_request_id: request.id, status: "expired" },
    );
  }
  const handout = await takeApprovalCapability({
    orgId: claims.orgId,
    runId: claims.runId,
    requestId: request.id,
  });
  if (!handout) {
    return errorResult(
      "This approval's one-shot capability was already delivered and cannot be re-issued. If the operation did not complete, submit a new approval_request.",
      { approval_request_id: request.id, status: "approved", error: "capability_already_delivered" },
    );
  }
  return textResult(
    `Approved. Immediately call ${request.toolName} with the exact same arguments plus this approvalCapability. It is single use${handout.expiresAt ? ` and expires at ${handout.expiresAt.toISOString()}` : ""}.`,
    {
      approval_request_id: request.id,
      status: "approved",
      tool_name: request.toolName,
      approval_capability: handout.capability,
      capability_expires_at: handout.expiresAt?.toISOString() ?? null,
    },
  );
}

export async function executeApprovalRequestToolLocal(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (name === "approval_request") return requestApproval(claims, args);
  if (name === "approval_poll") return pollApproval(claims, args);
  return errorResult(`Unknown tool: ${name}`);
}

function primaryApiOrigin(): string | null {
  if (!process.env.GATEWAY_DATABASE_URL) return null;
  const raw = process.env.SKYNET_API_ORIGIN?.trim();
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
  const response = await fetch(`${origin}/api/internal/gateway-approval-requests`, {
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
      body?.error ?? `approval control plane returned HTTP ${response.status}`,
      { status: response.status },
    );
  }
  return body.result;
}

/**
 * The standalone gateway holds a restricted database role and never writes
 * approval state itself: it delegates to the loopback primary API under a
 * freshly minted, short-lived copy of the current live capability, exactly
 * like automation tools. Local development executes in-process.
 */
export async function executeApprovalRequestTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const origin = primaryApiOrigin();
  if (process.env.GATEWAY_DATABASE_URL && !origin) {
    return errorResult(
      "approval control plane is not configured; ask the workspace operator to set SKYNET_API_ORIGIN for the gateway, then retry",
    );
  }
  return origin
    ? executeThroughPrimaryApi(origin, claims, name, args)
    : executeApprovalRequestToolLocal(claims, name, args);
}

function bearer(header: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

/**
 * Loopback bridge used only by the restricted tool-gateway process. It
 * authenticates the same short-lived run capability as MCP and re-resolves the
 * currently live run before touching approval state. No organization or user
 * identity is accepted from the body.
 */
export const internalApprovalRequestRoutes = new Hono();

internalApprovalRequestRoutes.post("/", async (c) => {
  const claims = verifyToolToken(bearer(c.req.header("authorization")));
  if (!claims) return c.json({ error: "unauthorized" }, 401);
  const current = await resolveToolRunIdentity(claims).catch(() => null);
  if (!current) return c.json({ error: "inactive_capability" }, 403);

  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return c.json({ error: "request_too_large" }, 413);
  }
  let body: unknown;
  try {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return c.json({ error: "request_too_large" }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const record = body as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  if (!APPROVAL_REQUEST_TOOL_NAMES.has(name)) {
    return c.json({ error: "unknown_approval_tool" }, 400);
  }
  const args = record.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return c.json({ error: "invalid_arguments" }, 400);
  }

  return c.json({
    result: await executeApprovalRequestToolLocal(
      current,
      name,
      args as Record<string, unknown>,
    ),
  });
});
