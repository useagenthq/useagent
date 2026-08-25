import { describe, expect, test } from "bun:test";
import {
  assertPublicationRequestMatches,
  assertChangeSetExpiry,
  assertRunRepositoryBinding,
  GITHUB_CHANGE_SET_MAX_TTL_MS,
  GitHubPublicationIdempotencyConflictError,
} from "./publication-repo";

describe("github publication idempotency", () => {
  test("rejects reusing an idempotency key for a different frozen request", () => {
    expect(() =>
      assertPublicationRequestMatches(
        { requestFingerprint: "a".repeat(64) },
        "b".repeat(64),
      ),
    ).toThrow(GitHubPublicationIdempotencyConflictError);
  });
});

describe("github change-set repository binding", () => {
  test("rejects freezing changes for a repository not persisted on the run", () => {
    const run = {
      resolvedResources: [
        {
          kind: "code.repository" as const,
          provider: "github" as const,
          locator: {
            type: "github.repository" as const,
            repository: "acme/api",
            revision: null,
          },
          capabilities: ["content.read" as const, "code.checkout" as const],
          provenance: [
            {
              source: "explicit" as const,
              channel: "api" as const,
              raw: "acme/api",
              start: null,
              end: null,
            },
          ],
        },
      ],
    };
    expect(() => assertRunRepositoryBinding(run, "acme/web")).toThrow(
      "repoFullName is not bound to this run",
    );
    expect(() => assertRunRepositoryBinding(run, "ACME/API")).not.toThrow();
    expect(() =>
      assertRunRepositoryBinding(
        { resolvedResources: [], repo: "acme/api", repos: ["acme/api"] } as unknown as Parameters<
          typeof assertRunRepositoryBinding
        >[0],
        "acme/api",
      ),
    ).toThrow("repoFullName is not bound to this run");
  });
});

describe("github change-set expiry", () => {
  test("rejects caller TTLs beyond the server maximum", () => {
    const now = Date.now();
    expect(() =>
      assertChangeSetExpiry(new Date(now + GITHUB_CHANGE_SET_MAX_TTL_MS + 1), now),
    ).toThrow("expiresAt must be within the server change-set TTL");
    expect(() =>
      assertChangeSetExpiry(new Date(now + GITHUB_CHANGE_SET_MAX_TTL_MS), now),
    ).not.toThrow();
  });
});
