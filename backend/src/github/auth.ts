import {
  devModeEnabled,
  githubAppConfig,
  githubConfig,
  githubTenantOrgId,
  type GithubAuthSource,
} from "../env";
import {
  getInstallationToken,
  getRepositoryInstallationToken,
} from "./app-auth";

// ---------------------------------------------------------------------------
// One place that turns configured credentials into concrete bearer tokens.
// Backend-only GitHub calls retain PAT > App > anonymous precedence. Retained
// sandboxes use the separate repo-aware resolver at the bottom of this file.
// ---------------------------------------------------------------------------

export interface GithubAuth {
  /** Bearer for GitHub API calls + private clones: a PAT, a freshly-valid App
   *  installation token, or null when only public access is available. */
  token: string | null;
  /** org/user whose repos to list (may be null in the token-only PAT case). */
  owner: string | null;
  source: GithubAuthSource;
}

/**
 * Resolve the active GitHub auth. A configured PAT wins outright; otherwise a
 * configured App mints (or reuses) an installation token; otherwise we're
 * anonymous. The App branch can throw if GitHub rejects the creds — callers that
 * must not fail (the listing) catch it and degrade to an honest error.
 */
export async function resolveGithubAuth(): Promise<GithubAuth> {
  const { token: pat, owner } = githubConfig();
  if (pat) return { token: pat, owner, source: "pat" };

  const app = githubAppConfig();
  if (app) {
    const { token } = await getInstallationToken(app);
    return { token, owner: owner ?? app.org, source: "app" };
  }

  return { token: null, owner, source: "anon" };
}

/**
 * Just the bearer token for backend-only GitHub operations. Never use this for
 * a retained sandbox; use {@link resolveGithubSandboxToken} with the exact repo.
 */
export async function resolveGithubToken(): Promise<string | null> {
  return (await resolveGithubAuth()).token;
}

/**
 * Resolve the only credential allowed to cross into a retained sandbox.
 * GitHub App auth deliberately wins over a configured PAT here because the App
 * can mint an exact-repository, read-only token. Production refuses PAT-only
 * deployments; local development keeps the old convenience path behind the
 * existing verified dev-mode gate.
 */
export async function resolveGithubSandboxToken(
  repository: string,
  orgId?: string | null,
): Promise<string | null> {
  const app = githubAppConfig();
  const { token: pat } = githubConfig();
  const production = process.env.NODE_ENV === "production" || !devModeEnabled();
  if (production && (app || pat)) {
    const tenantOrgId = githubTenantOrgId();
    if (!tenantOrgId) {
      throw new Error(
        "GitHub sandbox access is not assigned to a product organization; " +
          "set GITHUB_TENANT_ORG_ID to the owning organization id",
      );
    }
    if (!orgId || orgId !== tenantOrgId) {
      throw new Error("GitHub sandbox access is not available to this organization");
    }
  }

  if (app) {
    return (await getRepositoryInstallationToken(repository, app)).token;
  }

  if (!pat) return null;
  if (process.env.NODE_ENV !== "production" && devModeEnabled()) return pat;
  throw new Error(
    `cannot prepare ${repository} in a retained sandbox with a deployment-wide GitHub token; ` +
      "configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, install the App on this repository, " +
      "and grant Contents: read",
  );
}
