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
): AcpPermissionOutcome {
  if (!autoApprove) return { outcome: { outcome: "cancelled" } };
  const pick =
    options.find((o) => o.kind === "allow_once") ??
    options.find((o) => o.kind === "allow_always") ??
    options[0];
  return pick?.optionId
    ? { outcome: { outcome: "selected", optionId: pick.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

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
