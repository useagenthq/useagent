import {
  type ResourceCatalogPage,
  type ResourceCatalogScope,
} from "../../resources/catalog";
import { productionResourceCatalogService } from "../../resources/catalog-service";
import {
  projectRunResourceBindings,
} from "../../resources/access-snapshot";
import { getRunForOrg } from "../../runs/repo";
import type { GatewayToolDescriptor } from "./descriptor";
import { executeGithubBackedOperation } from "./github-operation-bridge";
import { errorResult, textResult } from "./tool-results";
import type { ToolTokenClaims } from "./token";

const MAX_QUERY_CHARS = 160;
const MAX_CURSOR_CHARS = 64;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export interface ResourceToolService {
  search(
    scope: ResourceCatalogScope,
    provider: string,
    input: { readonly query: string | null; readonly cursor: string | null; readonly limit: number },
  ): Promise<ResourceCatalogPage>;
  bindings(claims: ToolTokenClaims): Promise<readonly Record<string, unknown>[]>;
}

interface ResourceToolDependencies {
  search: ResourceToolService["search"];
  getRun: typeof getRunForOrg;
}

export { projectRunResourceBindings } from "../../resources/access-snapshot";

export function createResourceToolService(
  dependencies: ResourceToolDependencies,
): ResourceToolService {
  return {
    search: dependencies.search,
    async bindings(claims) {
      const run = await dependencies.getRun(claims.orgId, claims.runId);
      if (!run || run.threadId !== claims.threadId) {
        throw new Error("run not found in this thread");
      }
      return projectRunResourceBindings({
        runId: run.id,
        resources: run.resolvedResources ?? [],
        repos: run.repos ?? [],
      });
    },
  };
}

const productionService = createResourceToolService({
  search: (scope, provider, input) =>
    productionResourceCatalogService.search(scope, provider, input),
  getRun: getRunForOrg,
});

let serviceOverride: ResourceToolService | null = null;

export function setResourceToolServiceForTest(service: ResourceToolService | null): void {
  serviceOverride = service;
}

function service(): ResourceToolService {
  return serviceOverride ?? productionService;
}

export const RESOURCE_TOOLS = [
  {
    name: "resource_catalog_search",
    description:
      "List repositories this organization can access through its connected GitHub integration. " +
      "This is the authoritative answer to connected GitHub repository inventory; the sandbox filesystem is not, and an empty sandbox does not mean no access. " +
      "Catalog results are discoverable inventory only: they are not attached to this run and are not present in the sandbox unless separately selected and bound.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Connected integration provider id, for example github.",
        },
        query: {
          type: "string",
          description: "Optional provider resource name filter. Omit to list the first page.",
        },
        cursor: {
          type: "string",
          description: "Optional opaque cursor returned by the previous page.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      },
      required: ["provider"],
      additionalProperties: false,
    },
  },
  {
    name: "run_resource_bindings",
    description:
      "List the durable resources and capabilities explicitly authorized for this run. " +
      "Bindings are authorization, not connected-account inventory and not proof that a repository is already cloned in the sandbox.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const satisfies readonly GatewayToolDescriptor[];

function checkedString(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`${name} must be between 1 and ${max} characters`);
  }
  return normalized;
}

function checkedProvider(value: unknown): string {
  const provider = checkedString(value, "provider", 80);
  if (!provider) throw new Error("provider is required");
  return provider.toLowerCase();
}

function checkedLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(value, MAX_LIMIT);
}

export async function executeResourceToolLocal(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
) {
  try {
    if (name === "resource_catalog_search") {
      if (!claims.userId) {
        return errorResult(
          "Connected resource inventory requires an authenticated user identity.",
        );
      }
      const provider = checkedProvider(args.provider);
      const page = await service().search(
        { orgId: claims.orgId, userId: claims.userId },
        provider,
        {
          query: checkedString(args.query, "query", MAX_QUERY_CHARS),
          cursor: checkedString(args.cursor, "cursor", MAX_CURSOR_CHARS),
          limit: checkedLimit(args.limit),
        },
      );
      return textResult(
        page.status === "not_connected"
          ? `No ${provider} integration is connected for this workspace.`
          : page.items.length > 0
          ? `Found ${page.items.length} visible ${provider} resource${page.items.length === 1 ? "" : "s"}. These are inventory, not run bindings.`
          : `No visible ${provider} resources matched.`,
        {
          provider,
          status: page.status,
          items: page.items,
          nextCursor: page.nextCursor,
          complete: page.complete,
        },
      );
    }
    if (name === "run_resource_bindings") {
      const bindings = await service().bindings(claims);
      return textResult(
        bindings.length > 0
          ? `This run has ${bindings.length} authorized resource binding${bindings.length === 1 ? "" : "s"}.`
          : "This run has no authorized resource bindings. Connected inventory may still be available through resource_catalog_search.",
        { bindings },
      );
    }
    return errorResult(`Unknown resource tool: ${name}`);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : "resource tool failed");
  }
}

export async function executeResourceTool(
  claims: ToolTokenClaims,
  name: string,
  args: Record<string, unknown>,
) {
  const provider = typeof args.provider === "string" ? args.provider.trim().toLowerCase() : "";
  if (name !== "resource_catalog_search" || provider !== "github") {
    return executeResourceToolLocal(claims, name, args);
  }
  return executeGithubBackedOperation(
    claims,
    "resource",
    name,
    args,
    () => executeResourceToolLocal(claims, name, args),
  );
}
