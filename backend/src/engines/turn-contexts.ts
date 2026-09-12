import { type ResourceAccessSnapshot, formatResourceAccessContext } from "../resources/access-snapshot";
import { type SkillCatalogPage, frameSkillCatalogContext } from "../skills/catalog";

/**
 * The per-turn reference contexts the worker hands every engine, framed once:
 * recalled memory, the org's skill catalog page, and the resource access
 * snapshot. Each is "" when there is nothing to say.
 */
export function frameTurnContexts(input: {
  readonly recall: { readonly rendered?: string } | null | undefined;
  readonly skillCatalogPage: Pick<SkillCatalogPage, "skills" | "nextCursor"> | null | undefined;
  readonly resourceSnapshot: ResourceAccessSnapshot | null | undefined;
}): { turnContext: string; skillCatalogContext: string; resourceContext: string } {
  return {
    turnContext: input.recall?.rendered ?? "",
    skillCatalogContext: input.skillCatalogPage ? frameSkillCatalogContext(input.skillCatalogPage) : "",
    resourceContext: input.resourceSnapshot ? formatResourceAccessContext(input.resourceSnapshot) : "",
  };
}
