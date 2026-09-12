import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { slackWorkspaces } from "../db/schema";
import {
  githubAuthSource,
  githubConfigured,
  githubConfig,
  githubTenantOrgId,
  legacySlackEnabled,
} from "../env";
import type { ManagedConnectionBackend } from "./backend";

export const githubManagedBackend: ManagedConnectionBackend = {
  kind: "managed",
  provider: "github",
  async readStatus(scope) {
    const tenantOrgId = githubTenantOrgId();
    const connected = githubConfigured() && (!tenantOrgId || tenantOrgId === scope.orgId);
    return {
      provider: "github",
      label: "GitHub",
      description: "Native repository discovery, cloning, and pull request workflows.",
      authMethod: "custom_credential",
      configured: connected,
      status: connected ? "connected" : "unavailable",
      ...(!connected ? { degradationReason: "GitHub is not configured for this organization." } : {}),
      ...(connected
        ? {
            account: {
              displayName: githubConfig().owner ?? `Native ${githubAuthSource()} connection`,
            },
          }
        : {}),
    };
  },
};

export const slackManagedBackend: ManagedConnectionBackend = {
  kind: "managed",
  provider: "slack",
  async readStatus(scope) {
    const [workspace] = legacySlackEnabled()
      ? await db
          .select({ teamId: slackWorkspaces.teamId })
          .from(slackWorkspaces)
          .where(eq(slackWorkspaces.orgId, scope.orgId))
          .limit(1)
      : [];
    return {
      provider: "slack",
      label: "Slack",
      description: "Native events, threads, files, and streaming cards.",
      authMethod: "oauth2",
      configured: legacySlackEnabled(),
      status: workspace ? "connected" : "unavailable",
      ...(!workspace ? { degradationReason: "No verified Slack workspace is connected." } : {}),
      ...(workspace ? { account: { externalAccountId: workspace.teamId } } : {}),
    };
  },
};

export const managedConnectionBackends = [githubManagedBackend, slackManagedBackend] as const;
