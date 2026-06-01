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
): AcpPermissionOutcome {
  const trustedActiveRunTool = isTrustedActiveRunTool(toolTitle);
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

const GATEWAY_TOOL_PREFIXES = [
  "mcp.skynet-knowledge.",
  "mcp__skynet-knowledge__",
] as const;

function registeredGatewayToolFromTitle(title: string): string | null {
  for (const prefix of GATEWAY_TOOL_PREFIXES) {
    if (!title.startsWith(prefix)) continue;
    const name = title.slice(prefix.length);
    return name && isRegisteredGatewayToolName(name) ? name : null;
  }
  return null;
}

function isTrustedActiveRunTool(toolTitle: string | undefined): boolean {
  if (!toolTitle) return false;
  return TRUSTED_SANDBOX_NATIVE_TOOLS.has(toolTitle) ||
    registeredGatewayToolFromTitle(toolTitle) !== null;
}
