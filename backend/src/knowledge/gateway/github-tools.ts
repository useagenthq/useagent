import { resolveGithubCatalogAuth } from "../../github/auth";
import { parseRepoRef } from "../../github/repo-ref";
import { githubOrgAccessErrorForOrg } from "../../github/repos";
import { getRunForOrg } from "../../runs/repo";
import { hasGitHubRepositoryCheckoutIntent } from "../../resources/public-github";
import type { ResourceCapability, RunResource } from "../../resources/types";
import {
  githubAuthor,
  githubHeadEvidenceText,
  readGithubHeadEvidence,
  type GithubEvidenceService,
} from "./github-pr-evidence";
import { GITHUB_TOOL_NAMES, GITHUB_TOOLS } from "./github-tool-catalog";
import { errorResult, textResult } from "./tool-results";
import type { ToolCallResult } from "./tools";
import type { ToolTokenClaims } from "./token";

export { GITHUB_TOOL_NAMES, GITHUB_TOOLS };

// ---------------------------------------------------------------------------
// Execution for the read-only GitHub tool family (see github-tool-catalog.ts).
// Two hard properties, both enforced here and never in prompt text:
//  - repo binding: a tool call may only touch a repository the RUN was bound to
//    (runs.repos, decoded via parseRepoRef); anything else is rejected with the
//    bound set named, so the model can self-correct.
//  - server-side auth: the App/PAT bearer is resolved inside the gateway per
//    call (installation tokens rotate) and appears only in the outbound fetch
//    headers; tool results carry bounded JSON summaries, never credentials.
// ---------------------------------------------------------------------------

/** GitHub tool effects, seamed for hermetic tests. */
export interface GithubReadService extends GithubEvidenceService {
  /** Clean "owner/name" repositories bound to the calling run. */
  boundRepos(claims: ToolTokenClaims): Promise<string[]>;
  /** Persisted, revision-pinned PR capabilities granted to the calling run. */
  pullRequestGrants(claims: ToolTokenClaims): Promise<readonly GithubPullRequestGrant[]>;
}

export interface GithubPullRequestGrant {
  readonly repository: string;
  readonly number: number;
  readonly revision: string | null;
  readonly capabilities: readonly ResourceCapability[];
}

export function boundGithubRepositories(run: {
  readonly repos: readonly string[];
  readonly resolvedResources: readonly RunResource[];
}): string[] {
  const repositories = new Map<string, string>();
  const add = (repository: string) => {
    const key = repository.toLowerCase();
    if (!repositories.has(key)) repositories.set(key, repository);
  };
  for (const entry of run.repos) add(parseRepoRef(entry).repo);
  for (const resource of run.resolvedResources) {
    if (resource.provider !== "github") continue;
    if (resource.locator.type !== "github.repository") continue;
    if (!resource.capabilities.includes("content.read")) continue;
    if (!hasGitHubRepositoryCheckoutIntent(resource)) continue;
    add(resource.locator.repository);
  }
  return [...repositories.values()];
}

const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_BODY_CHARS = 4_000;
const MAX_FILES = 50;
const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PR_DETAIL_CAPABILITIES = [
  "change.read",
  "change.checks.read",
  "deployment.read",
] as const satisfies readonly ResourceCapability[];

/** GitHub shapes (only the fields we read). */
interface GhPull {
  number: number;
  title?: string;
  state?: string;
  draft?: boolean;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user?: { login?: string } | null;
  head?: { ref?: string; sha?: string } | null;
  base?: { ref?: string } | null;
}

interface GhPullDetail extends GhPull {
  body?: string | null;
  merged?: boolean;
  merged_at?: string | null;
  commits?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

interface GhPullFile {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
}

interface GhIssue {
  number: number;
  title?: string;
  state?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  comments?: number;
  user?: { login?: string } | null;
  labels?: ReadonlyArray<string | { name?: string | null } | null>;
  pull_request?: unknown;
}

function ghHeaders(token: string | null): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "skynet-a",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

const productionServiceBase = {
  async boundRepos(claims) {
    const run = await getRunForOrg(claims.orgId, claims.runId);
    if (!run || run.threadId !== claims.threadId) throw new Error("run not found in this thread");
    return boundGithubRepositories(run);
  },

  async pullRequestGrants(claims) {
    const run = await getRunForOrg(claims.orgId, claims.runId);
    if (!run || run.threadId !== claims.threadId) throw new Error("run not found in this thread");
    return run.resolvedResources.flatMap((resource) =>
      resource.locator.type === "github.pull_request"
        ? [{
            repository: resource.locator.repository,
            number: resource.locator.number,
            revision: resource.locator.revision,
            capabilities: resource.capabilities,
          }]
        : [],
    );
  },

} satisfies Omit<GithubReadService, "fetchJson">;

function productionServiceForOrg(orgId: string): GithubReadService {
  return {
    ...productionServiceBase,
    async fetchJson(path) {
      const { token } = await resolveGithubCatalogAuth(orgId);
      if (!token) {
        throw new Error(
          "GitHub is not connected for this organization; connect the GitHub App, then retry",
        );
      }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${GITHUB_API}${path}`, {
        headers: ghHeaders(token),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
    },
  };
}

let serviceOverride: GithubReadService | null = null;

/** Test-only seam. Production always uses the run row + server-side auth above. */
export function setGithubReadServiceForTest(service: GithubReadService | null): void {
  serviceOverride = service;
}

async function serviceForCall(claims: ToolTokenClaims): Promise<GithubReadService> {
  if (serviceOverride) return serviceOverride;
  const accessError = await githubOrgAccessErrorForOrg(claims.orgId);
  if (accessError) throw new Error(accessError);
  return productionServiceForOrg(claims.orgId);
}

function checkedRepo(value: unknown): string {
  const repo = typeof value === "string" ? value.trim() : "";
  if (!repo || repo.length > 140 || !REPO_SHAPE.test(repo)) {
    throw new Error("repo must be a GitHub repository full name (owner/name)");
  }
  return repo;
}

function checkedState(value: unknown): "open" | "closed" | "all" {
  if (value === undefined || value === null || value === "") return "open";
  if (value === "open" || value === "closed" || value === "all") return value;
  throw new Error("state must be one of open, closed, or all");
}

function checkedLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(value, MAX_LIMIT);
}

function checkedNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("number must be a positive pull request number");
  }
  return value;
}

/** Resolve the requested repo against the run's bound set, or throw a clear,
 *  self-correctable rejection. Comparison is case-insensitive (GitHub repo
 *  names are); the canonical bound form is what gets fetched. */
async function boundRepoOrThrow(
  service: GithubReadService,
  claims: ToolTokenClaims,
  requested: string,
): Promise<string> {
  const bound = await service.boundRepos(claims);
  if (bound.length === 0) {
    throw new Error(
      "this run has no bound repositories; GitHub read tools only cover repositories selected for the run",
    );
  }
  const match = bound.find((repo) => repo.toLowerCase() === requested.toLowerCase());
  if (!match) {
    throw new Error(
      `repository "${requested}" is not bound to this run; bound repositories: ${bound.join(", ")}`,
    );
  }
  return match;
}

async function pullRequestGrantOrThrow(
  service: GithubReadService,
  claims: ToolTokenClaims,
  repository: string,
  number: number,
): Promise<GithubPullRequestGrant> {
  const grants = await service.pullRequestGrants(claims);
  const grant = grants.find(
    (candidate) =>
      candidate.repository.toLowerCase() === repository.toLowerCase() &&
      candidate.number === number,
  );
  if (!grant) {
    throw new Error(
      `pull request ${repository}#${number} is not authorized for this run; ` +
        "bind that exact pull request before requesting its details",
    );
  }
  if (!grant.revision) {
    throw new Error(
      `pull request ${repository}#${number} has no pinned authorized revision; start a new run from the PR link`,
    );
  }
  const missing = PR_DETAIL_CAPABILITIES.filter(
    (capability) => !grant.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    throw new Error(
      `pull request ${repository}#${number} is missing required capabilities: ${missing.join(", ")}`,
    );
  }
  return grant;
}

interface PullSummary {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly draft: boolean;
  readonly author: string;
  readonly head: string | null;
  readonly base: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly url: string | null;
}

function toPullSummary(p: GhPull): PullSummary {
  return {
    number: p.number,
    title: p.title ?? "",
    state: p.state ?? "unknown",
    draft: Boolean(p.draft),
    author: githubAuthor(p.user),
    head: p.head?.ref ?? null,
    base: p.base?.ref ?? null,
    created_at: p.created_at ?? null,
    updated_at: p.updated_at ?? null,
    url: p.html_url ?? null,
  };
}

async function listPullRequests(
  service: GithubReadService,
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const repo = await boundRepoOrThrow(service, claims, checkedRepo(args.repo));
  const state = checkedState(args.state);
  const limit = checkedLimit(args.limit);
  const raw = await service.fetchJson(
    `/repos/${repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=${limit}`,
  );
  const pulls = (Array.isArray(raw) ? (raw as GhPull[]) : [])
    .slice(0, limit)
    .map(toPullSummary);
  const lines = pulls.map(
    (p) =>
      `#${p.number} [${p.state}${p.draft ? ", draft" : ""}] ${p.title} (${p.author}) ${p.head ?? "?"} -> ${p.base ?? "?"}`,
  );
  return textResult(
    lines.length > 0 ? lines.join("\n") : `No ${state} pull requests in ${repo}.`,
    { repository: repo, state, pull_requests: pulls },
  );
}

async function pullRequestDetail(
  service: GithubReadService,
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const requestedRepo = checkedRepo(args.repo);
  const number = checkedNumber(args.number);
  const grant = await pullRequestGrantOrThrow(service, claims, requestedRepo, number);
  const repo = grant.repository;
  const detail = (await service.fetchJson(`/repos/${repo}/pulls/${number}`)) as GhPullDetail;
  const headSha = detail.head?.sha ? detail.head.sha : null;
  if (!headSha || headSha.toLowerCase() !== grant.revision!.toLowerCase()) {
    throw new Error(
      `pull request ${repo}#${number} no longer matches its authorized revision; start a new run from the PR link`,
    );
  }
  const filesPromise = service.fetchJson(
    `/repos/${repo}/pulls/${number}/files?per_page=${MAX_FILES}`,
  );
  const evidencePromise = readGithubHeadEvidence(service, repo, headSha);
  const [rawFiles, evidence] = await Promise.all([filesPromise, evidencePromise]);
  const files = (Array.isArray(rawFiles) ? (rawFiles as GhPullFile[]) : [])
    .slice(0, MAX_FILES)
    .map((f) => ({
      filename: f.filename ?? "",
      status: f.status ?? "unknown",
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    }));
  const body = typeof detail.body === "string" ? detail.body : null;
  const bodyTruncated = body !== null && body.length > MAX_BODY_CHARS;
  const changedFiles = detail.changed_files ?? files.length;
  const summary = {
    repository: repo,
    number: detail.number,
    title: detail.title ?? "",
    state: detail.state ?? "unknown",
    draft: Boolean(detail.draft),
    merged: Boolean(detail.merged),
    author: githubAuthor(detail.user),
    body: bodyTruncated ? `${body.slice(0, MAX_BODY_CHARS)}\n[body truncated]` : body,
    body_truncated: bodyTruncated,
    head: detail.head?.ref ?? null,
    head_sha: headSha,
    base: detail.base?.ref ?? null,
    created_at: detail.created_at ?? null,
    updated_at: detail.updated_at ?? null,
    merged_at: detail.merged_at ?? null,
    commits: detail.commits ?? null,
    additions: detail.additions ?? null,
    deletions: detail.deletions ?? null,
    changed_files: changedFiles,
    files,
    files_truncated: changedFiles > files.length,
    url: detail.html_url ?? null,
    ...evidence,
  };
  const baseText =
    `PR #${summary.number} ${summary.title}\n` +
    `${repo} ${summary.head ?? "?"} @ ${headSha} -> ${summary.base ?? "?"} | state ${summary.state}` +
    `${summary.draft ? " (draft)" : ""}${summary.merged ? " (merged)" : ""} | author ${summary.author}\n` +
    `${changedFiles} files changed (+${summary.additions ?? "?"} -${summary.deletions ?? "?"})` +
    `${summary.files_truncated ? `, first ${files.length} listed` : ""}`;
  const text = [baseText, ...githubHeadEvidenceText(evidence)].join("\n");
  return textResult(text, summary);
}

async function listIssues(
  service: GithubReadService,
  claims: ToolTokenClaims,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const repo = await boundRepoOrThrow(service, claims, checkedRepo(args.repo));
  const state = checkedState(args.state);
  const limit = checkedLimit(args.limit);
  // GitHub's issues endpoint interleaves PRs; over-fetch one page and filter.
  const raw = await service.fetchJson(
    `/repos/${repo}/issues?state=${state}&sort=updated&direction=desc&per_page=100`,
  );
  const issues = (Array.isArray(raw) ? (raw as GhIssue[]) : [])
    .filter((issue) => issue.pull_request === undefined)
    .slice(0, limit)
    .map((issue) => ({
      number: issue.number,
      title: issue.title ?? "",
      state: issue.state ?? "unknown",
      author: githubAuthor(issue.user),
      labels: (issue.labels ?? [])
        .map((label) => (typeof label === "string" ? label : label?.name ?? ""))
        .filter((name) => name.length > 0)
        .slice(0, 10),
      comments: issue.comments ?? 0,
      created_at: issue.created_at ?? null,
      updated_at: issue.updated_at ?? null,
      url: issue.html_url ?? null,
    }));
  const lines = issues.map(
    (issue) =>
      `#${issue.number} [${issue.state}] ${issue.title} (${issue.author})` +
      `${issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : ""}`,
  );
  return textResult(
    lines.length > 0 ? lines.join("\n") : `No ${state} issues in ${repo}.`,
    { repository: repo, state, issues },
  );
}

export async function executeGithubTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    if (
      name !== "github_list_prs" &&
      name !== "github_pr_detail" &&
      name !== "github_list_issues"
    ) {
      return errorResult(`Unknown GitHub tool: ${name}`);
    }
    const service = await serviceForCall(claims);
    if (name === "github_list_prs") return await listPullRequests(service, claims, args);
    if (name === "github_pr_detail") return await pullRequestDetail(service, claims, args);
    return await listIssues(service, claims, args);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : "github operation failed");
  }
}
