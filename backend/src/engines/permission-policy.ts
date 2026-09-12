/**
 * ACP / CLI tool-permission policy. ONE fail-closed decision
 * point both the resident ACP relay (acp-server.ts), the local ACP bridge (acp.ts),
 * and the CLI runner (sandbox.ts) route through - so there is no second place that
 * can silently re-open yolo.
 *
 * Default is DENY. Production selects allow-once only for exact sandbox-native
 * tools or exact operations implemented by the signed run gateway. The gateway
 * remains the authority boundary for tenant scope and destructive-operation
 * approvals; this policy only permits the isolated harness to make the RPC call.
 * Permission-skipping CLI flags remain restricted to verified development mode.
 */
import { acpAutoApprove } from "../env";
import {
  LEGACY_TOOL_GATEWAY_SERVER_NAME,
  TOOL_GATEWAY_SERVER_NAME,
} from "../knowledge/gateway/descriptor";
import { isRegisteredGatewayToolName } from "../knowledge/gateway/operation-registry";

/** A permission option as advertised by an ACP `session/request_permission`. */
export interface AcpPermissionOption {
  optionId?: string;
  kind?: string;
}

/** The JSON-RPC `result` for a `session/request_permission` response. */
export type AcpPermissionOutcome =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

/**
 * Decide one ACP permission request. Fail CLOSED: DENY (`cancelled`) unless the
 * title resolves to a trusted active-run tool or dev-yolo auto-approve is on.
 * Production accepts allow-once only. `autoApprove` is injectable for tests;
 * it defaults to the env-derived, dev-gated {@link acpAutoApprove}.
 */
export function decideAcpPermission(
  options: readonly AcpPermissionOption[],
  autoApprove: boolean = acpAutoApprove(),
  toolTitle?: string,
  toolKind?: string,
): AcpPermissionOutcome {
  const trustedActiveRunTool = isTrustedActiveRunTool(toolTitle, toolKind);
  if (!autoApprove && !trustedActiveRunTool) {
    return { outcome: { outcome: "cancelled" } };
  }
  if (trustedActiveRunTool && !autoApprove) {
    const allowOnce = options.find((option) => option.kind === "allow_once");
    return allowOnce?.optionId
      ? { outcome: { outcome: "selected", optionId: allowOnce.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }
  const pick =
    options.find((o) => o.kind === "allow_once") ??
    options.find((o) => o.kind === "allow_always") ??
    options[0];
  return pick?.optionId
    ? { outcome: { outcome: "selected", optionId: pick.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

/** An inbound ACP `session/request_permission` JSON-RPC request as the agent sends it. */
export interface AcpPermissionRequest {
  id: number;
  params?: {
    options?: readonly AcpPermissionOption[];
    toolCall?: { toolCallId?: string; kind?: string; title?: string };
  };
}

/** The `tool_call` update previously recorded for the same tool call id, if any. */
export interface AcpRecordedToolCall {
  kind?: unknown;
  title?: unknown;
}

/**
 * Build the complete JSON-RPC response to one ACP permission request through
 * {@link decideAcpPermission}. The request's own `toolCall.kind` is what the agent
 * asks to do (codex-acp sends `execute` for a shell escalation even when the
 * recorded tool_call was presented as `read`), so it wins over the recorded
 * kind; the title falls back the other way because permission requests from
 * codex-acp carry none.
 */
export function answerAcpPermissionRequest(
  request: AcpPermissionRequest,
  recorded?: AcpRecordedToolCall,
  autoApprove: boolean = acpAutoApprove(),
): { jsonrpc: "2.0"; id: number; result: AcpPermissionOutcome } {
  const toolCall = request.params?.toolCall ?? {};
  const kind = toolCall.kind ??
    (typeof recorded?.kind === "string" ? recorded.kind : undefined);
  const title = (typeof recorded?.title === "string" ? recorded.title : undefined) ??
    toolCall.title;
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: decideAcpPermission(request.params?.options ?? [], autoApprove, title, kind),
  };
}

const TRUSTED_SANDBOX_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  "Agent",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "Read",
  "Task",
  "Write",
]);

// ACP providers may localize or rename the presentation title (Claude exposes
// its shell tool as "Execute"), but the semantic kind remains stable. Trust only
// exact native kinds whose effects are confined to the already-isolated thread
// sandbox; arbitrary titles and MCP `other` calls still fail closed.
const TRUSTED_SANDBOX_NATIVE_KINDS: ReadonlySet<string> = new Set(["execute"]);

const GATEWAY_TOOL_PREFIXES = [
  `mcp.${TOOL_GATEWAY_SERVER_NAME}.`,
  `mcp__${TOOL_GATEWAY_SERVER_NAME}__`,
  `mcp.${LEGACY_TOOL_GATEWAY_SERVER_NAME}.`,
  `mcp__${LEGACY_TOOL_GATEWAY_SERVER_NAME}__`,
] as const;

function registeredGatewayToolFromTitle(title: string): string | null {
  for (const prefix of GATEWAY_TOOL_PREFIXES) {
    if (!title.startsWith(prefix)) continue;
    const name = title.slice(prefix.length);
    return name && isRegisteredGatewayToolName(name) ? name : null;
  }
  return null;
}

function isTrustedActiveRunTool(
  toolTitle: string | undefined,
  toolKind: string | undefined,
): boolean {
  if (toolKind && TRUSTED_SANDBOX_NATIVE_KINDS.has(toolKind)) return true;
  if (!toolTitle) return false;
  return TRUSTED_SANDBOX_NATIVE_TOOLS.has(toolTitle) ||
    registeredGatewayToolFromTitle(toolTitle) !== null;
}
