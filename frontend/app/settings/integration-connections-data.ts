import type { IntegrationSummary } from "@useagent/agent-client/integrations";

// The integration summary WIRE CONTRACT - the row shape, the backend set, and the
// browser-safe decoders - is the shared agent-client contract (the backend
// integration service builds exactly this shape). Re-exported here so the settings
// surfaces and their tests keep one local import path instead of a hand-copied
// mirror that could drift from the server.
export type {
  IntegrationAuthMethod,
  IntegrationBackend,
  IntegrationPermissionSummary,
  IntegrationSummary,
} from "@useagent/agent-client/integrations";
export {
  decodeIntegrationSummaries,
  decodeIntegrationSummary,
  INTEGRATION_AUTH_METHODS,
  INTEGRATION_BACKENDS,
  integrationAccountLabel,
} from "@useagent/agent-client/integrations";

export function integrationAuthLabel(summary: IntegrationSummary): string | null {
  if (summary.authMethod === "oauth2") return "OAuth 2.0";
  if (summary.authMethod === "api_key") return "API key";
  if (summary.authMethod === "custom_credential") return "Managed credential";
  return null;
}

export function integrationPermissionLabels(summary: IntegrationSummary): string[] {
  const labels: string[] = [];
  if (summary.permissions.scopes.length > 0) {
    labels.push(
      `${summary.permissions.scopes.length} ${summary.permissions.scopes.length === 1 ? "scope" : "scopes"}`,
    );
  }
  if (summary.permissions.actionCount > 0) {
    labels.push(
      `${summary.permissions.actionCount} ${summary.permissions.actionCount === 1 ? "action" : "actions"}`,
    );
  }
  for (const effect of summary.permissions.effects) {
    labels.push(
      effect === "destructive"
        ? "Destructive actions"
        : `${effect.charAt(0).toUpperCase()}${effect.slice(1)} actions`,
    );
  }
  if (summary.permissions.approvals.includes("interactive")) labels.push("Approval required");
  if (summary.permissions.approvals.includes("disabled")) labels.push("Some actions disabled");
  return labels;
}
