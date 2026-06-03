import { githubResourceCatalogProvider } from "./github-catalog";
import {
  ResourceCatalogRegistry,
  type ResourceCatalogPage,
  type ResourceCatalogScope,
  type ResourceCatalogSearchInput,
} from "./catalog";

export interface ResourceCatalogService {
  providerIds(): readonly string[];
  search(
    scope: ResourceCatalogScope,
    provider: string,
    input: ResourceCatalogSearchInput,
  ): Promise<ResourceCatalogPage>;
}

const registry = new ResourceCatalogRegistry([githubResourceCatalogProvider]);

export const productionResourceCatalogService: ResourceCatalogService = {
  providerIds: () => registry.providerIds(),
  search: (scope, provider, input) => registry.search(scope, provider, input),
};
