import { formatRepoRef, parseRepoRef } from "../github/repo-ref";
import {
  githubResourceResolver,
  isSafeGitRevision,
  normalizeGitHubRepository,
} from "./github-resolver";
import {
  extractResourceReferences,
  ResourceResolverRegistry,
} from "./resolver-registry";
import {
  RunIntakeError,
  type ExplicitRunResource,
  type ResourceAuthorization,
  type ResourceAuthorizationDecision,
  type ResourceCapability,
  type ResourceDescriptor,
  type ResourceProvenance,
  type RunIntakeSource,
  type RunIntakeInput,
  type RunIntakeResult,
  type RunResource,
} from "./types";

export * from "./types";
export { githubResourceResolver } from "./github-resolver";
export { extractResourceReferences, ResourceResolverRegistry } from "./resolver-registry";

export const MAX_RUN_RESOURCE_REFERENCES = 24;
export const MAX_RUN_RESOURCES = 12;

export const defaultResourceResolverRegistry = new ResourceResolverRegistry([
  githubResourceResolver,
]);

export interface RunIntakeDependencies {
  readonly authorize: ResourceAuthorization;
  readonly registry?: ResourceResolverRegistry;
}

function resourceKey(resource: ResourceDescriptor | RunResource): string {
  switch (resource.locator.type) {
    case "github.repository":
      return `github:repository:${resource.locator.repository.toLowerCase()}`;
    case "github.pull_request":
      return `github:pull:${resource.locator.repository.toLowerCase()}:${resource.locator.number}`;
    case "file":
      return `${resource.provider}:file:${resource.locator.id}`;
    case "web.page":
      return `${resource.provider}:page:${resource.locator.url}`;
  }
}

function invalidExplicit(resource: ExplicitRunResource, message: string): never {
  throw new RunIntakeError({
    code: "resource_invalid",
    message,
    provider: resource.provider,
    reference: `${resource.provider}:${resource.kind}`,
    action: "Select a valid resource and retry.",
  });
}

function explicitDescriptor(resource: ExplicitRunResource): ResourceDescriptor {
  switch (resource.locator.type) {
    case "github.repository": {
      const repository = normalizeGitHubRepository(resource.locator.repository);
      if (
        resource.kind !== "code.repository" ||
        resource.provider !== "github" ||
        !repository ||
        !isSafeGitRevision(resource.locator.revision)
      ) {
        invalidExplicit(resource, "Invalid explicit GitHub repository resource.");
      }
      resource = { ...resource, locator: { ...resource.locator, repository } };
      break;
    }
    case "github.pull_request": {
      const repository = normalizeGitHubRepository(resource.locator.repository);
      if (
        resource.kind !== "code.change" ||
        resource.provider !== "github" ||
        !repository ||
        !Number.isSafeInteger(resource.locator.number) ||
        resource.locator.number <= 0 ||
        !isSafeGitRevision(resource.locator.revision)
      ) {
        invalidExplicit(resource, "Invalid explicit GitHub pull-request resource.");
      }
      // A caller may select the PR identity, never its authorization revision.
      // Only the server-side authorizer may pin a fresh PR; inherited resources
      // bypass this explicit-input path and retain their prior immutable pin.
      resource = {
        ...resource,
        locator: { ...resource.locator, repository, revision: null },
      };
      break;
    }
    case "file":
      if (
        resource.kind !== "file" ||
        !resource.provider.trim() ||
        !resource.locator.id.trim() ||
        resource.locator.id.length > 512
      ) {
        invalidExplicit(resource, "Invalid explicit file resource.");
      }
      break;
    case "web.page": {
      let url: URL;
      try {
        url = new URL(resource.locator.url);
      } catch {
        invalidExplicit(resource, "Invalid explicit web-page resource.");
      }
      if (
        resource.kind !== "web.page" ||
        !resource.provider.trim() ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      ) {
        invalidExplicit(resource, "Invalid explicit web-page resource.");
      }
      resource = { ...resource, locator: { type: "web.page", url: url.href } };
      break;
    }
  }
  const capabilities = (() => {
    if (resource.capabilities) return resource.capabilities;
    switch (resource.locator.type) {
      case "github.repository":
        return ["content.read", "code.checkout"] as const;
      case "github.pull_request":
        return ["change.read", "change.checks.read", "deployment.read"] as const;
      case "file":
        return ["file.read"] as const;
      case "web.page":
        return ["page.read"] as const;
    }
  })();
  return {
    ...resource,
    capabilities,
  } as ResourceDescriptor;
}

function withProvenance(
  resource: ResourceDescriptor,
  provenance: ResourceProvenance,
): RunResource {
  return { ...resource, provenance: [provenance] } as RunResource;
}

function mergeResource(target: RunResource[], incoming: RunResource): void {
  const key = resourceKey(incoming);
  const index = target.findIndex((resource) => resourceKey(resource) === key);
  if (index === -1) {
    target.push(incoming);
    return;
  }
  const current = target[index]!;
  target[index] = {
    ...current,
    provenance: [...current.provenance, ...incoming.provenance],
  } as RunResource;
}

function decisionCapabilities(
  resource: RunResource,
  decision: boolean | ResourceAuthorizationDecision,
): readonly ResourceCapability[] {
  if (typeof decision === "boolean") return resource.capabilities;
  return decision.capabilities ?? resource.capabilities;
}

function decisionRevision(
  resource: RunResource,
  decision: boolean | ResourceAuthorizationDecision,
): string | null | undefined {
  if (typeof decision === "boolean" || decision.revision === undefined) return undefined;
  return decision.revision;
}

function applyAuthorizationDecision(
  resource: RunResource,
  decision: boolean | ResourceAuthorizationDecision,
): RunResource {
  const available = typeof decision === "boolean" ? decision : decision.available;
  if (!available) {
    const reference =
      resource.locator.type === "github.repository" ||
      resource.locator.type === "github.pull_request"
        ? resource.locator.repository
        : resource.locator.type === "web.page"
          ? resource.locator.url
          : resource.locator.id;
    throw new RunIntakeError({
      code: "resource_unauthorized",
      message:
        typeof decision === "object" && decision.message
          ? decision.message
          : `Resource ${reference} is unavailable. Connect ${resource.provider} or select a resource you can access.`,
      provider: resource.provider,
      reference,
      action: `Connect ${resource.provider} or select a resource you can access.`,
    });
  }

  const capabilities = decisionCapabilities(resource, decision);
  const revision = decisionRevision(resource, decision);
  if (
    revision !== undefined &&
    (resource.locator.type === "github.repository" ||
      resource.locator.type === "github.pull_request")
  ) {
    return {
      ...resource,
      capabilities,
      locator: { ...resource.locator, revision },
    } as RunResource;
  }
  return { ...resource, capabilities } as RunResource;
}

function legacyRepos(resources: readonly RunResource[]): string[] {
  return resources.flatMap((resource) => {
    if (resource.locator.type !== "github.repository") return [];
    return [
      formatRepoRef(
        resource.locator.repository,
        resource.locator.revision,
      ),
    ];
  });
}

function rejectConflictingChanges(resources: readonly RunResource[]): void {
  const changesByRepository = new Map<string, number>();
  for (const resource of resources) {
    if (resource.locator.type !== "github.pull_request") continue;
    const repository = resource.locator.repository.toLowerCase();
    const existing = changesByRepository.get(repository);
    if (existing === undefined) {
      changesByRepository.set(repository, resource.locator.number);
      continue;
    }
    if (existing === resource.locator.number) continue;
    throw new RunIntakeError({
      code: "resource_ambiguous",
      message:
        `Run intake accepts one pull request per repository; received ` +
        `${resource.locator.repository}#${existing} and #${resource.locator.number}.`,
      provider: "github",
      reference: resource.locator.repository,
      action: "Select one pull request for this repository and retry.",
    });
  }
}

/** Convert the legacy repo picker payload into typed explicit resources. */
export function explicitRepositoryResources(
  repos: readonly string[],
): readonly ExplicitRunResource[] {
  return repos.map((entry) => {
    const { repo, branch } = parseRepoRef(entry);
    return {
      kind: "code.repository",
      provider: "github",
      locator: {
        type: "github.repository",
        repository: repo,
        revision: branch,
      },
    } satisfies ExplicitRunResource;
  });
}

/**
 * Upgrade an old parent run that predates `resolvedResources`. The marker is
 * deliberately distinct from a new explicit selection: it records that the
 * control plane inherited a previously accepted legacy scope.
 */
export function legacyParentResources(
  repos: readonly string[],
  channel: RunIntakeSource,
): readonly RunResource[] {
  return explicitRepositoryResources(repos).map((resource) => {
    const descriptor = explicitDescriptor(resource);
    return withProvenance(descriptor, {
      source: "legacy_parent",
      channel,
      raw: resourceKey(descriptor),
      start: null,
      end: null,
    });
  });
}

function enforceResourceLimit(count: number, kind: "references" | "resources"): void {
  const limit = kind === "references" ? MAX_RUN_RESOURCE_REFERENCES : MAX_RUN_RESOURCES;
  if (count <= limit) return;
  throw new RunIntakeError({
    code: "resource_limit_exceeded",
    message: `Run intake accepts at most ${limit} ${kind}; received ${count}.`,
    provider: null,
    reference: null,
    action: `Remove resources until the request contains at most ${limit} ${kind}.`,
  });
}

/**
 * Resolve the same typed resource set for every ingress. Only `text` and
 * explicit user selections can add resources; `untrustedText` is intentionally
 * absent from discovery so retrieved/model-authored context cannot widen scope.
 */
export async function resolveRunIntake(
  input: RunIntakeInput,
  dependencies: RunIntakeDependencies,
): Promise<RunIntakeResult> {
  const resources: RunResource[] = [];

  enforceResourceLimit(input.explicitResources?.length ?? 0, "resources");
  enforceResourceLimit(input.inheritedResources?.length ?? 0, "resources");

  for (const explicit of input.explicitResources ?? []) {
    const descriptor = explicitDescriptor(explicit);
    mergeResource(
      resources,
      withProvenance(descriptor, {
        source: "explicit",
        channel: input.source,
        raw: resourceKey(descriptor),
        start: null,
        end: null,
      }),
    );
  }
  for (const inherited of input.inheritedResources ?? []) {
    mergeResource(resources, inherited);
  }

  const references = extractResourceReferences(input.text);
  enforceResourceLimit(references.length, "references");
  const registry = dependencies.registry ?? defaultResourceResolverRegistry;
  for (const reference of references) {
    for (const descriptor of registry.resolve(reference)) {
      mergeResource(
        resources,
        withProvenance(descriptor, {
          source: "user_text",
          channel: input.source,
          raw: reference.raw,
          start: reference.start,
          end: reference.end,
        }),
      );
    }
  }
  enforceResourceLimit(resources.length, "resources");
  rejectConflictingChanges(resources);

  const authorized: RunResource[] = [];
  for (const resource of resources) {
    authorized.push(
      applyAuthorizationDecision(resource, await dependencies.authorize(resource)),
    );
  }

  return { resources: authorized, repos: legacyRepos(authorized) };
}
