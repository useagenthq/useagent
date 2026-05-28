import { acpAutoApprove } from "../env";

/** Permission-skipping CLI flags are a development-only escape hatch. Keep
 * this env-only decision independent from the production gateway registry so
 * CLI command rendering does not load every gateway tool family. */
export function allowPermissionBypass(
  autoApprove: boolean = acpAutoApprove(),
): boolean {
  return autoApprove;
}
