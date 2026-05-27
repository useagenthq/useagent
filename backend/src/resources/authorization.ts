import { resolveGithubAuth } from "../github/auth";
import { listRepos, unknownRepos, type RepoListing } from "../github/repos";
import type {
  ResourceAuthorization,
  ResourceAuthorizationDecision,
} from "./types";

const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 8_000;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/iu;

interface GitHubPullResponse {
  readonly number?: number;
  readonly head?: { readonly sha?: string } | null;
  readonly base?: {
    readonly repo?: { readonly full_name?: string } | null;
  } | null;
}

export interface RunResourceAuthorizationDependencies {
  readonly listRepos?: (orgId: string) => Promise<RepoListing>;
  readonly unknownRepos?: (repos: string[], orgId: string) => Promise<string[]>;
  readonly verifyPullRequest?: (
    repository: string,
    number: number,
  ) => Promise<{ readonly headSha: string }>;
}

/** Server-side GitHub PR verification shared by every run ingress. */
export async function verifyGithubPullRequest(
  repository: string,
  number: number,
): Promise<{ readonly headSha: string }> {
  const auth = await resolveGithubAuth();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "skynet-a",
    };
    if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
    const response = await fetch(
      `${GITHUB_API}/repos/${repository}/pulls/${number}`,
      { headers, signal: controller.signal },
    );
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    const pull = (await response.json()) as GitHubPullResponse;
    const canonicalRepository = pull.base?.repo?.full_name;
    const headSha = pull.head?.sha;
    if (
      pull.number !== number ||
      !canonicalRepository ||
      canonicalRepository.toLowerCase() !== repository.toLowerCase() ||
      !headSha ||
      !COMMIT_SHA_RE.test(headSha)
    ) {
      throw new Error("GitHub returned an invalid pull request identity");
    }
    return { headSha: headSha.toLowerCase() };
  } finally {
    clearTimeout(timeout);
  }
}

function unavailable(message: string): ResourceAuthorizationDecision {
  return { available: false, message };
}

/**
 * Org-scoped, fail-closed authorization for resolved run resources. Generic
 * web-page hints need no provider credential; GitHub resources must be present
 * in the org's offered repository set, and PRs are verified and SHA-pinned.
 */
export function createRunResourceAuthorization(
  orgId: string,
  dependencies: RunResourceAuthorizationDependencies = {},
): ResourceAuthorization {
  const list = dependencies.listRepos ?? listRepos;
  const unknown = dependencies.unknownRepos ?? unknownRepos;
  const verifyPull = dependencies.verifyPullRequest ?? verifyGithubPullRequest;

  return async (resource) => {
    if (resource.locator.type === "web.page") {
      return unavailable(
        "Web pages are prompt context, not an authority-bearing run resource.",
      );
    }
    if (resource.locator.type === "file") {
      return unavailable(
        `File resource ${resource.locator.id} is not materialized for run intake. Reattach the file and retry.`,
      );
    }
    if (resource.provider !== "github") {
      return unavailable(
        `Resource provider ${resource.provider} is not connected for run intake.`,
      );
    }

    const repository = resource.locator.repository;
    let listing: RepoListing;
    try {
      listing = await list(orgId);
    } catch (error) {
      return unavailable(
        `Could not verify access to ${repository}: ${error instanceof Error ? error.message : "repository lookup failed"}. Retry after reconnecting GitHub.`,
      );
    }
    if (!listing.configured) {
      return unavailable(
        `GitHub is not connected for this organization. Connect GitHub, then retry ${repository}.`,
      );
    }
    if (listing.error) {
      return unavailable(
        `Could not verify access to ${repository}: ${listing.error}. Reconnect GitHub or retry later.`,
      );
    }

    let rejected: string[];
    try {
      rejected = await unknown([repository], orgId);
    } catch (error) {
      return unavailable(
        `Could not verify access to ${repository}: ${error instanceof Error ? error.message : "repository lookup failed"}. Retry after reconnecting GitHub.`,
      );
    }
    if (rejected.length > 0) {
      return unavailable(
        `Repository ${repository} is not available to this organization. Select a repository you can access or update the GitHub connection.`,
      );
    }

    if (resource.locator.type !== "github.pull_request") return true;
    // An inherited resource is already immutably pinned by its authoritative
    // parent. Re-check repository access above, but never move the thread to a
    // newer PR head behind the user's back.
    if (resource.locator.revision) return true;
    try {
      const { headSha } = await verifyPull(repository, resource.locator.number);
      return { available: true, revision: headSha };
    } catch (error) {
      return unavailable(
        `Could not verify pull request ${repository}#${resource.locator.number}: ${error instanceof Error ? error.message : "GitHub lookup failed"}. Confirm the PR exists and the GitHub connection can read it.`,
      );
    }
  };
}
