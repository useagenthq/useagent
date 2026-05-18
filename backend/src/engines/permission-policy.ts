/**
 * ACP / CLI tool-permission policy (final_harness.md P0). ONE fail-closed decision
 * point both the resident ACP relay (acp-server.ts), the local ACP bridge (acp.ts),
 * and the CLI runner (sandbox.ts) route through - so there is no second place that
 * can silently re-open yolo.
 *
 * Default is DENY. Auto-approval (and the corresponding permission-skipping CLI
 * flag / bypass mode) is only ever enabled by {@link acpAutoApprove}, which itself
 * requires verified development mode. A real approval-policy engine evaluated in
 * the trusted backend outside the sandbox is Phase 3 (#77); this is the safe interim.
 */
import { acpAutoApprove } from "../env";

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
 * Decide one ACP permission request. Fail CLOSED: DENY (`cancelled`) unless
 * dev-yolo auto-approve is on, in which case pick a one-shot allow (then
 * allow-always, then the first option). `autoApprove` is injectable for tests;
 * it defaults to the env-derived, dev-gated {@link acpAutoApprove}.
 */
export function decideAcpPermission(
  options: readonly AcpPermissionOption[],
  autoApprove: boolean = acpAutoApprove(),
  toolTitle?: string,
): AcpPermissionOutcome {
  const trustedActiveRunMcp =
    typeof toolTitle === "string" && TRUSTED_ACTIVE_RUN_MCP_TOOLS.has(toolTitle);
  if (!autoApprove && !trustedActiveRunMcp) {
    return { outcome: { outcome: "cancelled" } };
  }
  if (trustedActiveRunMcp && !autoApprove) {
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

const TRUSTED_ACTIVE_RUN_MCP_TOOLS: ReadonlySet<string> = new Set([
  "mcp.skynet-knowledge.computer_screenshot",
  "mcp.skynet-knowledge.computer_sequence",
  "mcp.skynet-knowledge.computer_click",
  "mcp.skynet-knowledge.computer_move",
  "mcp.skynet-knowledge.computer_drag",
  "mcp.skynet-knowledge.computer_type",
  "mcp.skynet-knowledge.computer_key",
  "mcp.skynet-knowledge.computer_hotkey",
  "mcp.skynet-knowledge.computer_scroll",
  "mcp.skynet-knowledge.desktop_recording_start",
  "mcp.skynet-knowledge.desktop_recording_stop",
  "mcp.skynet-knowledge.artifact_publish",
  "mcp.skynet-knowledge.web_search",
  "mcp.skynet-knowledge.gcs_list_buckets",
  "mcp.skynet-knowledge.github_repositories",
  "mcp.skynet-knowledge.github_clone_repository",
  "mcp.skynet-knowledge.loop_login_open",
  "mcp.skynet-knowledge.loop_login_destroy",
  "mcp.skynet-knowledge.skills_list",
  "mcp.skynet-knowledge.skill_activate",
  "mcp.skynet-knowledge.automation_list",
  "mcp.skynet-knowledge.automation_create",
  "mcp.skynet-knowledge.automation_update",
  "mcp.skynet-knowledge.automation_run_now",
  "mcp.skynet-knowledge.automation_history",
]);

/**
 * Whether to pass a permission-SKIPPING CLI flag (claude's
 * `--dangerously-skip-permissions`) or seed a bypass-permissions settings file.
 * Fail CLOSED: never, unless dev-yolo. A non-interactive CLI without the flag
 * simply cannot approve tools - which is the intended fail-closed behavior for a
 * team/SaaS deployment.
 */
export function allowPermissionBypass(autoApprove: boolean = acpAutoApprove()): boolean {
  return autoApprove;
}
