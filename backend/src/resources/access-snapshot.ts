import { resourcesWithLegacyRepositories, runResourceBindingId } from "./bindings";
import {
  productionResourceCatalogService,
  type ResourceCatalogService,
} from "./catalog-service";
import type { RunResource } from "./types";

const SNAPSHOT_SAMPLE_LIMIT = 10;
const MAX_NAME_CHARS = 160;

export interface ResourceAccessSnapshot {
  readonly version: 1;
  readonly sandboxFilesystemAuthoritative: false;
  readonly exactInventoryTool: "resource_catalog_search";
  readonly inventory: readonly {
    readonly provider: string;
    readonly status: "available" | "empty" | "not_connected" | "unavailable";
    readonly sampleNames: readonly string[];
    readonly sampleCount: number;
    readonly hasMore: boolean;
  }[];
  readonly runBindings: readonly Record<string, unknown>[];
}

export function projectRunResourceBindings(input: {
  readonly runId: string;
  readonly resources: readonly RunResource[];
  readonly repos: readonly string[];
}): readonly Record<string, unknown>[] {
  return resourcesWithLegacyRepositories({
    resources: input.resources,
    repos: input.repos,
  }).map((resource) => ({
    bindingId: runResourceBindingId(input.runId, resource),
    provider: resource.provider,
    kind: resource.kind,
    locator: resource.locator,
    capabilities: resource.capabilities,
    provenance: resource.provenance,
  }));
}

export async function buildResourceAccessSnapshot(
  input: {
    readonly orgId: string;
    readonly userId: string;
    readonly runId: string;
    readonly resources: readonly RunResource[];
    readonly repos: readonly string[];
  },
  catalog: ResourceCatalogService = productionResourceCatalogService,
): Promise<ResourceAccessSnapshot> {
  const scope = { orgId: input.orgId, userId: input.userId };
  const inventory = await Promise.all(
    catalog.providerIds().map(async (provider) => {
      try {
        const page = await catalog.search(scope, provider, {
          query: null,
          cursor: null,
          limit: SNAPSHOT_SAMPLE_LIMIT,
        });
        const sampleNames = page.items.map((item) => item.name.slice(0, MAX_NAME_CHARS));
        return {
          provider,
          status: page.status,
          sampleNames,
          sampleCount: sampleNames.length,
          hasMore: !page.complete || page.nextCursor !== null,
        } as const;
      } catch {
        return {
          provider,
          status: "unavailable",
          sampleNames: [],
          sampleCount: 0,
          hasMore: false,
        } as const;
      }
    }),
  );

  return {
    version: 1,
    sandboxFilesystemAuthoritative: false,
    exactInventoryTool: "resource_catalog_search",
    inventory,
    runBindings: projectRunResourceBindings(input),
  };
}

export function formatResourceAccessContext(snapshot: ResourceAccessSnapshot): string {
  return `<resource_access_snapshot>\n${JSON.stringify(snapshot)}\n</resource_access_snapshot>\n\n`;
}
