import { listGithubCatalog } from "../github/repos";
import {
  opaqueCatalogRef,
  stablePositiveNumericId,
  type ResourceCatalogProvider,
} from "./catalog";

interface GithubCatalogDependencies {
  readonly list?: typeof listGithubCatalog;
}

interface GithubCatalogCursor {
  readonly providerCursor: string | null;
  readonly offset: number;
}

function decodeCursor(value: string | null): GithubCatalogCursor {
  if (!value) return { providerCursor: null, offset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      providerCursor?: unknown;
      offset?: unknown;
    };
    if (
      (parsed.providerCursor !== null && typeof parsed.providerCursor !== "string") ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset as number) < 0
    ) {
      throw new Error("invalid shape");
    }
    return {
      providerCursor: parsed.providerCursor as string | null,
      offset: parsed.offset as number,
    };
  } catch {
    throw new Error("cursor is invalid");
  }
}

function encodeCursor(cursor: GithubCatalogCursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null;
}

export function createGithubResourceCatalogProvider(
  dependencies: GithubCatalogDependencies = {},
): ResourceCatalogProvider {
  const list = dependencies.list ?? listGithubCatalog;
  return {
    provider: "github",
    async search(scope, input) {
      const query = input.query?.trim().toLowerCase() ?? "";
      let cursor = decodeCursor(input.cursor);
      const items = [];
      const visited = new Set<string>();

      while (items.length < input.limit) {
        const cursorKey = `${cursor.providerCursor ?? "start"}:${cursor.offset}`;
        if (visited.has(cursorKey)) throw new Error("GitHub catalog cursor did not advance");
        visited.add(cursorKey);

        const listing = await list(scope.orgId, {
          cursor: cursor.providerCursor,
          maxPages: 1,
        });
        if (!listing.configured) {
          return { status: "not_connected", items: [], nextCursor: null, complete: true };
        }
        if (listing.error && listing.repos.length === 0) {
          // Surface a listing failure honestly instead of degrading to an empty
          // page: an empty page would read as "no repositories", the misleading
          // outcome we want to avoid. Frame the message so a caller never mistakes
          // a transient/auth listing failure for confirmed absence of access.
          throw new Error(
            `connected GitHub inventory listing failed: ${listing.error} ` +
              "(a listing error, not confirmation the organization has no accessible repositories)",
          );
        }
        const matches = listing.repos.filter((repo) => {
          if (!stablePositiveNumericId(repo.external_id)) return false;
          return !query ||
            repo.full_name.toLowerCase().includes(query) ||
            repo.name.toLowerCase().includes(query);
        });
        const remaining = matches.slice(cursor.offset);
        const capacity = input.limit - items.length;
        const selected = remaining.slice(0, capacity);
        items.push(...selected.map((repo) => ({
          catalogRef: opaqueCatalogRef({
            provider: "github",
            connectionId: listing.connectionId,
            externalId: stablePositiveNumericId(repo.external_id) as string,
          }),
          provider: "github",
          kind: "code.repository",
          name: repo.full_name,
          locator: { type: "github.repository", repository: repo.full_name },
          metadata: {
            private: repo.private,
            defaultBranch: repo.default_branch,
          },
        })));

        if (selected.length < remaining.length) {
          cursor = {
            providerCursor: cursor.providerCursor,
            offset: cursor.offset + selected.length,
          };
          break;
        }
        if (listing.complete || !listing.nextCursor) {
          cursor = { providerCursor: null, offset: 0 };
          return {
            status: items.length > 0 ? "available" : "empty",
            items,
            nextCursor: null,
            complete: true,
          };
        }
        cursor = { providerCursor: listing.nextCursor, offset: 0 };
      }

      return {
        status: items.length > 0 ? "available" : "empty",
        items,
        nextCursor: encodeCursor(cursor),
        complete: false,
      };
    },
  };
}

export const githubResourceCatalogProvider = createGithubResourceCatalogProvider();
