import type {
  IntegrationActionCatalogEntry,
  IntegrationPermissionSummary,
} from "@useagent/agent-client/integrations";

export interface IntegrationCatalogDefinition {
  readonly provider: string;
  readonly displayName: string;
  readonly description: string;
}

export const INTEGRATION_CATALOG = [
  {
    provider: "github",
    displayName: "GitHub",
    description: "Repository discovery, cloning, and pull request workflows.",
  },
  {
    provider: "slack",
    displayName: "Slack",
    description: "Events, threads, files, and streaming cards.",
  },
  {
    provider: "gmail",
    displayName: "Gmail",
    description: "Read, draft, and send email.",
  },
  {
    provider: "linear",
    displayName: "Linear",
    description: "Issues, projects, and team workflows.",
  },
  {
    provider: "notion",
    displayName: "Notion",
    description: "Pages, databases, and workspace content.",
  },
  {
    provider: "hubspot",
    displayName: "HubSpot",
    description: "CRM contacts, companies, and deals.",
  },
] as const satisfies readonly IntegrationCatalogDefinition[];

const catalogByProvider = new Map<string, IntegrationCatalogDefinition>(
  INTEGRATION_CATALOG.map((entry) => [entry.provider, entry] as const),
);

const INTERNAL_MECHANISM_NAMES = new Set([
  "oomol",
  "oomol_connector",
  "openconnector",
  "open_connector",
]);

function humanizeProvider(provider: string): string {
  return provider
    .split(/[\/_-]+/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function isUserFacingIntegrationProvider(provider: string): boolean {
  return Boolean(provider) && !INTERNAL_MECHANISM_NAMES.has(provider.toLowerCase());
}

export function integrationCatalogDefinition(provider: string): IntegrationCatalogDefinition {
  return catalogByProvider.get(provider) ?? {
    provider,
    displayName: humanizeProvider(provider),
    description: `${humanizeProvider(provider)} account connection.`,
  };
}

export function summarizeIntegrationPermissions(input: {
  readonly scopes?: readonly string[];
  readonly actions?: readonly IntegrationActionCatalogEntry[];
}): IntegrationPermissionSummary {
  const scopes = [...new Set(input.scopes ?? [])]
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0 && scope.length <= 128)
    .slice(0, 32);
  const actions = (input.actions ?? []).slice(0, 10_000);
  return {
    scopes,
    actionCount: actions.length,
    effects: [...new Set(actions.map((action) => action.effect))],
    approvals: [...new Set(actions.map((action) => action.approval))],
  };
}
