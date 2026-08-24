import { ensureRepoClone, shq } from "../../engines/repo-prep";
import { formatRepoRef, parseRepoRef } from "../../github/repo-ref";
import {
  hasExactGitHubRepositoryUrlProvenance,
  parseExactGitHubRepositoryUrl,
} from "../../resources/public-github";
import type { RunResource } from "../../resources/types";
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
  list(
    claims: ToolTokenClaims,
    query: string | null,
  ): Promise<RunBoundRepository[]>;
  clone(
    claims: ToolTokenClaims,
    query: string,
    branch: string | null,
  ): Promise<RepositoryCloneResult>;
}

const canonicalRepositoryIdentity = (value: string): string =>
  value.trim().toLowerCase();

export interface RunBoundRepository {
  readonly full_name: string;
  readonly name: string;
  /** Exact revision selected on the run, or null when the run did not pin one. */
  readonly revision: string | null;
}

/** Resolve only when one accessible repository is the unambiguous match. */
export function resolveRepositoryQuery(
  repos: readonly RunBoundRepository[],
  query: string,
): RunBoundRepository | null {
  const requested = canonicalRepositoryIdentity(query);
  if (!requested) return null;
  const exactFullName = repos.filter(
    (repo) => canonicalRepositoryIdentity(repo.full_name) === requested,
  );
  if (exactFullName.length === 1) return exactFullName[0] ?? null;

  const exactName = repos.filter(
    (repo) => canonicalRepositoryIdentity(repo.name) === requested,
  );
  return exactName.length === 1 ? (exactName[0] ?? null) : null;
}

/** Project the exact durable repository bindings authorized on this run.
 *  Connected-account catalog metadata is deliberately not consulted: catalog
 *  visibility and run authorization are separate concerns. */
export function repositoriesForRun(
  runRepos: readonly string[],
  resolvedResources: readonly RunResource[] = [],
): RunBoundRepository[] {
  const repositories = new Map<string, RunBoundRepository>();
  const add = (fullName: string, revision: string | null) => {
    const name = fullName.split("/").at(-1) ?? fullName;
    const key = `${canonicalRepositoryIdentity(fullName)}\0${revision ?? ""}`;
    if (!repositories.has(key)) {
      repositories.set(key, { full_name: fullName, name, revision });
    }
  };

  for (const entry of runRepos) {
    const { repo, branch } = parseRepoRef(entry);
    add(repo, branch);
  }
  for (const resource of resolvedResources) {
    if (
      resource.provider !== "github" ||
      resource.locator.type !== "github.repository" ||
      !resource.capabilities.includes("code.checkout")
    ) {
      continue;
    }
    add(resource.locator.repository, resource.locator.revision);
  }
  return [...repositories.values()];
}

export interface RepositoryCloneTarget {
  readonly fullName: string;
  readonly revision: string | null;
  readonly useGithubCredential: boolean;
}

/** Resolve the exact clone trust path. Canonical public URLs deliberately skip
 *  organization credentials; every credentialed target must resolve directly
 *  from the current run's persisted repository bindings. */
export function resolveRepositoryCloneTarget(
  runRepos: readonly string[],
  query: string,
  authorizedResources: readonly RunResource[] = [],
): RepositoryCloneTarget | null {
  const publicRepository = parsePublicGitHubUrl(query);
  if (publicRepository) {
    const authorized = authorizedResources.find(
      (resource) =>
        resource.locator.type === "github.repository" &&
        resource.locator.repository === publicRepository &&
        hasExactGitHubRepositoryUrlProvenance(resource),
    );
    if (!authorized) return null;
    return {
      fullName: publicRepository,
      revision: authorized.locator.type === "github.repository"
        ? authorized.locator.revision
        : null,
      useGithubCredential: false,
    };
  }
  const repository = resolveRepositoryQuery(
    repositoriesForRun(runRepos, authorizedResources),
    query,
  );
  return repository
    ? {
        fullName: repository.full_name,
        revision: repository.revision,
        useGithubCredential: true,
      }
    : null;
}

/**
 * Accept only a canonical public GitHub HTTPS repository URL. This is the
 * narrow external-source escape hatch for sandboxed agents: the trusted
 * gateway performs the network operation while the provider's shell remains
 * network-isolated. No arbitrary host, port, path, query, or credentials are
 * accepted.
 */
export function parsePublicGitHubUrl(query: string): string | null {
  return parseExactGitHubRepositoryUrl(query);
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

async function currentRun(claims: ToolTokenClaims) {
  const run = await getRunForOrg(claims.orgId, claims.runId);
  if (!run || run.threadId !== claims.threadId) {
    throw new Error("run not found in this thread");
  }
  return run;
}

const productionService: RepositoryService = {
  async list(claims, query) {
    const run = await currentRun(claims);
    const repos = repositoriesForRun(run.repos, run.resolvedResources ?? []);
    if (!query) return repos.slice(0, 50);
    const repository = resolveRepositoryQuery(repos, query);
    return repository ? [repository] : [];
  },

  async clone(claims, query, branch) {
    const run = await currentRun(claims);
    const target = resolveRepositoryCloneTarget(
      run.repos,
      query,
      run.resolvedResources ?? [],
    );
    if (!target) {
      throw new Error(
        `repository query "${query}" is not attached to this run or is ambiguous; choose the repository when starting the thread, then use github_repositories to confirm it`,
      );
    }
    if (!run.sandboxId) throw new Error("no sandbox is attached to this run");
    const apiKey = sandboxProviderApiKey();
    if (apiKey === undefined) throw new Error("sandbox provider credentials are not set");
    const sandbox = await sandboxProvider(apiKey).get(run.sandboxId);
    const fullName = target.fullName;
    if (target.revision && branch && target.revision !== branch) {
      throw new Error(
        `repository ${fullName} is attached to this run at revision ${target.revision}, not ${branch}`,
      );
    }
    const requestedRevision = branch ?? target.revision;
    const entry = formatRepoRef(fullName, requestedRevision);
    await ensureRepoClone(
      sandbox,
      "/root/work",
      entry,
      { emit: async () => undefined, orgId: claims.orgId },
      { useGithubCredential: target.useGithubCredential },
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
      throw new Error(
        `failed to verify cloned repository ${fullName}; the clone likely failed (network or access) - retry once, and report it if it repeats`,
      );
    }
    return {
      repository: fullName,
      branch: actualBranch || requestedRevision || "HEAD",
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
      "List GitHub repositories explicitly bound to the current run. This is run authorization, not the connected account inventory; an empty result means no repository was selected for this run, not that the organization lacks GitHub access. " +
      "To discover every repository the organization can access, use resource_catalog_search. Use this tool only to resolve names within the run's authorized repository set.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional exact owner/name or unique exact repository name within this run.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "github_clone_repository",
    description:
      "Resolve one repository attached to the current run, or accept an exact public https://github.com/owner/repo URL, and clone it into the current sandbox. " +
      "Private repository authentication is supplied one-shot by the trusted gateway and is never returned. " +
      "Public URL clones never receive organization credentials. The fixed destination is /root/work/<owner>/<repo>.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Exact run-attached owner/name, unique exact repository name, or exact public GitHub HTTPS URL.",
        },
        branch: {
          type: "string",
          description:
            "Optional branch. Omit to use the revision selected on the run, or the remote default when the run did not pin one.",
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
      const repos = await service.list(claims, query);
      const lines = repos.map(
        (repo) =>
          `- ${repo.full_name}${repo.revision ? ` (revision: ${repo.revision})` : ""}`,
      );
      return result(
        lines.length > 0 ? lines.join("\n") : "No matching run-bound repositories.",
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
