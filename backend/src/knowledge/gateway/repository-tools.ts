import { ensureRepoClone, shq } from "../../engines/repo-prep";
import { formatRepoRef } from "../../github/repo-ref";
import { listRepos, type RepoInfo } from "../../github/repos";
import { getRunForOrg } from "../../runs/repo";
import {
  sandboxProvider,
  sandboxProviderApiKey,
} from "../../sandboxes/provider";
import type { ToolTokenClaims } from "./token";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface RepositoryCloneResult {
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
  readonly path: string;
}

interface RepositoryService {
  list(query: string | null): Promise<RepoInfo[]>;
  clone(
    claims: ToolTokenClaims,
    query: string,
    branch: string | null,
  ): Promise<RepositoryCloneResult>;
}

const QUERY_NOISE = new Set([
  "clone",
  "github",
  "loop",
  "acme",
  "repo",
  "repository",
  "the",
]);

const normalize = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "");

const queryTerms = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term && !QUERY_NOISE.has(term));

/** Resolve only when one accessible repository is the unambiguous match. */
export function resolveRepositoryQuery(
  repos: readonly RepoInfo[],
  query: string,
): RepoInfo | null {
  const requested = query.trim();
  if (!requested) return null;
  const exactFullName = repos.filter(
    (repo) => normalize(repo.full_name) === normalize(requested),
  );
  if (exactFullName.length === 1) return exactFullName[0] ?? null;

  const terms = queryTerms(requested);
  if (terms.length === 0) return null;
  const exactName = repos.filter(
    (repo) => terms.length === 1 && normalize(repo.name) === normalize(terms[0] ?? ""),
  );
  if (exactName.length === 1) return exactName[0] ?? null;

  const candidates = repos.filter((repo) => {
    const haystack = normalize(repo.full_name);
    return terms.every((term) => haystack.includes(normalize(term)));
  });
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/**
 * Accept only a canonical public GitHub HTTPS repository URL. This is the
 * narrow external-source escape hatch for sandboxed agents: the trusted
 * gateway performs the network operation while the provider's shell remains
 * network-isolated. No arbitrary host, port, path, query, or credentials are
 * accepted.
 */
export function parsePublicGitHubUrl(query: string): string | null {
  let url: URL;
  try {
    url = new URL(query.trim());
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const parts = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0] ?? "";
  const name = (parts[1] ?? "").replace(/\.git$/i, "");
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner) ||
    !/^[a-z0-9_.-]{1,100}$/i.test(name) ||
    name === "." ||
    name === ".."
  ) {
    return null;
  }
  return `${owner}/${name}`;
}

function checkedQuery(value: unknown): string {
  const query = typeof value === "string" ? value.trim() : "";
  if (!query || query.length > 200) {
    throw new Error("repository query is required and must be at most 200 characters");
  }
  return query;
}

function checkedBranch(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("branch must be a string");
  const branch = value.trim();
  if (
    !branch ||
    branch.length > 200 ||
    /[\x00-\x20~^:?*[\\]/.test(branch) ||
    branch.startsWith("-") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{")
  ) {
    throw new Error("branch is not a safe Git branch name");
  }
  return branch;
}

async function availableRepos(): Promise<RepoInfo[]> {
  const listing = await listRepos();
  if (!listing.configured) throw new Error("GitHub is not configured");
  if (listing.error && listing.repos.length === 0) throw new Error(listing.error);
  return listing.repos;
}

const productionService: RepositoryService = {
  async list(query) {
    const repos = await availableRepos();
    if (!query) return repos.slice(0, 50);
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    return repos
      .filter((repo) => {
        const haystack = normalize(repo.full_name);
        return terms.every((term) => haystack.includes(normalize(term)));
      })
      .slice(0, 50);
  },

  async clone(claims, query, branch) {
    const publicRepository = parsePublicGitHubUrl(query);
    const repository = publicRepository
      ? null
      : resolveRepositoryQuery(await availableRepos(), query);
    if (!publicRepository && !repository) {
      throw new Error(
        `repository query "${query}" is unknown or ambiguous; use github_repositories to choose an accessible repository`,
      );
    }
    const run = await getRunForOrg(claims.orgId, claims.runId);
    if (!run || run.threadId !== claims.threadId) throw new Error("run not found in this thread");
    if (!run.sandboxId) throw new Error("no sandbox is attached to this run");
    const apiKey = sandboxProviderApiKey();
    if (apiKey === undefined) throw new Error("sandbox provider credentials are not set");
    const sandbox = await sandboxProvider(apiKey).get(run.sandboxId);
    const fullName = publicRepository ?? repository!.full_name;
    const entry = formatRepoRef(fullName, branch);
    await ensureRepoClone(
      sandbox,
      "/root/work",
      entry,
      { emit: async () => undefined },
      { useGithubCredential: !publicRepository },
    );
    const path = `/root/work/${fullName}`;
    const revision = await sandbox.process.executeCommand(
      `git -C ${shq(path)} rev-parse HEAD && git -C ${shq(path)} rev-parse --abbrev-ref HEAD`,
      undefined,
      undefined,
      15,
    );
    const [commit = "", actualBranch = ""] = (revision.result ?? "")
      .trim()
      .split("\n");
    if ((revision.exitCode ?? 1) !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error(`failed to verify cloned repository ${fullName}`);
    }
    return {
      repository: fullName,
      branch: actualBranch || branch || repository?.default_branch || "HEAD",
      commit,
      path,
    };
  },
};

let serviceOverride: RepositoryService | null = null;

/** Test-only seam. Production always uses the GitHub App and run sandbox above. */
export function setRepositoryServiceForTest(service: RepositoryService | null): void {
  serviceOverride = service;
}

const result = (text: string, structuredContent?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structuredContent ? { structuredContent } : {}),
});

const failure = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export const REPOSITORY_TOOLS = [
  {
    name: "github_repositories",
    description:
      "List GitHub repositories available through the organization's connected GitHub App. " +
      "Use this to resolve natural names such as 'Acme backend' without asking the user for a URL.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional repository name or natural-language alias to filter by.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "github_clone_repository",
    description:
      "Resolve one accessible organization repository, or accept an exact public https://github.com/owner/repo URL, and clone it into the current sandbox. " +
      "Private repository authentication is supplied one-shot by the trusted gateway and is never returned. " +
      "Public URL clones never receive organization credentials. The fixed destination is /root/work/<owner>/<repo>.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Full accessible repository name, natural alias, or exact public GitHub HTTPS URL.",
        },
        branch: {
          type: "string",
          description: "Optional branch. Omit to use the repository default branch.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
] as const;

export const REPOSITORY_TOOL_NAMES: ReadonlySet<string> = new Set(
  REPOSITORY_TOOLS.map((tool) => tool.name),
);

export async function executeRepositoryTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const service = serviceOverride ?? productionService;
  try {
    if (name === "github_repositories") {
      const query = typeof args.query === "string" && args.query.trim()
        ? args.query.trim()
        : null;
      const repos = await service.list(query);
      const lines = repos.map(
        (repo) =>
          `- ${repo.full_name} (default: ${repo.default_branch}${repo.private ? ", private" : ""})`,
      );
      return result(
        lines.length > 0 ? lines.join("\n") : "No matching accessible repositories.",
        { repositories: repos },
      );
    }
    if (name === "github_clone_repository") {
      const cloned = await service.clone(
        claims,
        checkedQuery(args.query),
        checkedBranch(args.branch),
      );
      return result(
        `Cloned ${cloned.repository} (${cloned.branch}) at ${cloned.commit} to ${cloned.path}`,
        { ...cloned },
      );
    }
    return failure(`Unknown repository tool: ${name}`);
  } catch (error) {
    return failure(error instanceof Error ? error.message : "repository operation failed");
  }
}
