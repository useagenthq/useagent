import { createHash } from "node:crypto";

export interface ResourceCatalogScope {
  readonly orgId: string;
  readonly userId: string;
}

export interface ResourceCatalogSearchInput {
  readonly query: string | null;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ResourceCatalogItem {
  readonly catalogRef: string;
  readonly provider: string;
  readonly kind: string;
  readonly name: string;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ResourceCatalogPage {
  readonly items: readonly ResourceCatalogItem[];
  readonly nextCursor: string | null;
}

export function stablePositiveNumericId(value: string | null | undefined): string | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  return value;
}

export interface ResourceCatalogProvider {
  readonly provider: string;
  search(
    scope: ResourceCatalogScope,
    input: ResourceCatalogSearchInput,
  ): Promise<ResourceCatalogPage>;
}

export function opaqueCatalogRef(input: {
  readonly provider: string;
  readonly connectionId: string | null;
  readonly externalId: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.provider}\0${input.connectionId ?? "legacy"}\0${input.externalId}`)
    .digest("base64url")
    .slice(0, 24);
  return `rc_${digest}`;
}

export class ResourceCatalogRegistry {
  readonly #providers: ReadonlyMap<string, ResourceCatalogProvider>;

  constructor(providers: readonly ResourceCatalogProvider[]) {
    const index = new Map<string, ResourceCatalogProvider>();
    for (const provider of providers) {
      const id = provider.provider.trim().toLowerCase();
      if (!id || index.has(id)) {
        throw new Error(`duplicate or blank resource catalog provider: ${provider.provider}`);
      }
      index.set(id, provider);
    }
    this.#providers = index;
  }

  providerIds(): string[] {
    return [...this.#providers.keys()].sort();
  }

  async search(
    scope: ResourceCatalogScope,
    provider: string,
    input: ResourceCatalogSearchInput,
  ): Promise<ResourceCatalogPage> {
    const adapter = this.#providers.get(provider.trim().toLowerCase());
    if (!adapter) throw new Error(`resource catalog provider is not available: ${provider}`);
    return adapter.search(scope, input);
  }
}
