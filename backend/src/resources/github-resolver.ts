import {
  RunIntakeError,
  type GitHubPullRequestLocator,
  type GitHubRepositoryLocator,
  type ResourceDescriptor,
  type ResourceReference,
  type ResourceResolution,
  type ResourceResolver,
} from "./types";

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY_RE = /^[A-Za-z0-9._-]{1,100}$/u;
const RESERVED_OWNERS = new Set([
  "about",
  "collections",
  "features",
  "login",
  "marketplace",
  "notifications",
  "orgs",
  "search",
  "settings",
  "sponsors",
  "topics",
  "trending",
]);

const REPOSITORY_CAPABILITIES = ["content.read", "code.checkout"] as const;
const CHANGE_CAPABILITIES = [
  "change.read",
  "change.checks.read",
  "deployment.read",
] as const;

function githubUrl(raw: string): URL | null {
  try {
    const url = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`);
    if (
      url.hostname.toLowerCase() !== "github.com" ||
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function isGitHubReference(raw: string): boolean {
  try {
    const url = new URL(/^https?:\/\//iu.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

function canonicalRepository(owner: string, rawName: string): string | null {
  const name = rawName.replace(/\.git$/iu, "");
  if (
    !OWNER_RE.test(owner) ||
    RESERVED_OWNERS.has(owner.toLowerCase()) ||
    !REPOSITORY_RE.test(name) ||
    name === "." ||
    name === ".."
  ) {
    return null;
  }
  return `${owner}/${name}`;
}

export function normalizeGitHubRepository(reference: string): string | null {
  const segments = reference.trim().split("/");
  if (segments.length !== 2) return null;
  return canonicalRepository(segments[0] ?? "", segments[1] ?? "");
}

export function isSafeGitRevision(revision: string | null): boolean {
  if (revision === null) return true;
  return (
    revision.length > 0 &&
    revision.length <= 200 &&
    !/[\x00-\x20~^:?*[\\]/u.test(revision) &&
    !revision.startsWith("-") &&
    !revision.endsWith(".") &&
    !revision.includes("..") &&
    !revision.includes("@{")
  );
}

function invalid(reference: ResourceReference, message: string): never {
  throw new RunIntakeError({
    code: "resource_invalid",
    message,
    provider: "github",
    reference: reference.raw,
    action: "Use a canonical HTTPS GitHub repository or pull-request URL.",
  });
}

function repositoryDescriptor(locator: GitHubRepositoryLocator): ResourceDescriptor {
  return {
    kind: "code.repository",
    provider: "github",
    locator,
    capabilities: REPOSITORY_CAPABILITIES,
  };
}

function pullRequestDescriptor(locator: GitHubPullRequestLocator): ResourceDescriptor {
  return {
    kind: "code.change",
    provider: "github",
    locator,
    capabilities: CHANGE_CAPABILITIES,
  };
}

export const githubResourceResolver: ResourceResolver = {
  provider: "github",

  supports(reference) {
    return isGitHubReference(reference.raw);
  },

  resolve(reference): ResourceResolution {
    const url = githubUrl(reference.raw);
    if (!url) invalid(reference, `Invalid GitHub resource URL: ${reference.raw}`);
    const segments = url.pathname.split("/").filter(Boolean);
    const owner = segments[0] ?? "";
    const repository = canonicalRepository(owner, segments[1] ?? "");
    if (!repository) invalid(reference, `Invalid GitHub repository URL: ${reference.raw}`);

    const repositoryLocator: GitHubRepositoryLocator = {
      type: "github.repository",
      repository,
      revision: null,
    };
    if (segments.length === 2) {
      return { resources: [repositoryDescriptor(repositoryLocator)] };
    }

    const number = Number(segments[3]);
    if (
      segments.length !== 4 ||
      segments[2]?.toLowerCase() !== "pull" ||
      !Number.isSafeInteger(number) ||
      number <= 0
    ) {
      invalid(reference, `Unsupported GitHub resource URL: ${reference.raw}`);
    }
    const pullRequestLocator: GitHubPullRequestLocator = {
      type: "github.pull_request",
      repository,
      number,
      revision: null,
    };
    return {
      resources: [
        repositoryDescriptor(repositoryLocator),
        pullRequestDescriptor(pullRequestLocator),
      ],
    };
  },
};
