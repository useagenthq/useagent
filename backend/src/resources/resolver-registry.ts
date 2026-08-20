import {
  RunIntakeError,
  type ResourceDescriptor,
  type ResourceReference,
  type ResourceResolver,
} from "./types";

const HTTP_REFERENCE_RE = /https?:\/\/[^\s<>|"'`)\]}]+/giu;
const BARE_GITHUB_REFERENCE_RE = /(?<![\w.-])github\.com\/[^\s<>|"'`)\]}]+/giu;

function trimTrailingPunctuation(raw: string): string {
  return raw.replace(/[.,;:!?]+$/u, "");
}

export function extractResourceReferences(text: string): ResourceReference[] {
  const references: ResourceReference[] = [];
  for (const pattern of [HTTP_REFERENCE_RE, BARE_GITHUB_REFERENCE_RE]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      if (start === undefined) continue;
      const raw = trimTrailingPunctuation(match[0]);
      const end = start + raw.length;
      if (references.some((reference) => start < reference.end && end > reference.start)) {
        continue;
      }
      references.push({ raw, start, end });
    }
  }
  return references.toSorted((left, right) => left.start - right.start);
}

export class ResourceResolverRegistry {
  readonly #resolvers: readonly ResourceResolver[];

  constructor(resolvers: readonly ResourceResolver[]) {
    const providers = new Set<string>();
    for (const resolver of resolvers) {
      if (!resolver.provider.trim() || providers.has(resolver.provider)) {
        throw new Error(`duplicate or blank resource resolver provider: ${resolver.provider}`);
      }
      providers.add(resolver.provider);
    }
    this.#resolvers = [...resolvers];
  }

  resolve(reference: ResourceReference): readonly ResourceDescriptor[] {
    const resolvers = this.#resolvers.filter((resolver) => resolver.supports(reference));
    if (resolvers.length === 0) {
      // Ordinary user-authored web links remain prompt text. Only a registered
      // provider may turn a URL into a durable authority-bearing resource.
      return [];
    }
    if (resolvers.length > 1) {
      throw new RunIntakeError({
        code: "resource_ambiguous",
        message: `More than one resource provider claimed ${reference.raw}`,
        provider: null,
        reference: reference.raw,
        action: "Select the resource explicitly.",
      });
    }
    return resolvers[0]!.resolve(reference).resources;
  }
}
