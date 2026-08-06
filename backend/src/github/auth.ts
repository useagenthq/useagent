import { githubAppConfig, githubConfig, type GithubAuthSource } from "../env";
import { getInstallationToken } from "./app-auth";

// ---------------------------------------------------------------------------
// One place that turns the configured credentials into a concrete bearer token
// + listing scope, applying the precedence PAT > GitHub App > anonymous. Both
// the repo listing (src/github/repos.ts) and the sandbox clone
// (src/engines/opencode-server.ts) resolve through here, so the auth choice —
// and the "mint a fresh installation token" step — lives in exactly one spot.
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
 * Just the bearer token for the current auth — used at clone time, where the App
 * path needs a token that is still fresh (installation tokens expire ~1h, so we
 * resolve one per clone; the cache re-mints only when the previous one is near
 * expiry). Returns null for a public clone.
 */
export async function resolveGithubToken(): Promise<string | null> {
  return (await resolveGithubAuth()).token;
}
