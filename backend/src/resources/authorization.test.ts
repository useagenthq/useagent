import { describe, expect, test } from "bun:test";
import {
  createRunResourceAuthorization,
  verifyPublicGithubRepository,
} from "./authorization";
import { resolveRunIntake } from "./run-intake";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("run resource authorization", () => {
  test("admits an exact public GitHub repository URL without consulting org repos", async () => {
    const calls: string[] = [];
    const intake = await resolveRunIntake(
      {
        source: "api",
        text: "Run this generic repo https://github.com/octocat/Hello-World.git",
      },
      {
        authorize: createRunResourceAuthorization("org-1", {
          listRepos: async () => {
            throw new Error("org repo listing must not authorize exact public URLs");
          },
          verifyPublicRepository: async (repository) => {
            calls.push(repository);
          },
        }),
      },
    );

    expect(calls).toEqual(["octocat/Hello-World"]);
    expect(intake.repos).toEqual(["octocat/Hello-World"]);
    expect(intake.resources).toEqual([
      expect.objectContaining({
        kind: "code.repository",
        provider: "github",
        locator: {
          type: "github.repository",
          repository: "octocat/Hello-World",
          revision: null,
        },
        capabilities: ["content.read", "code.checkout"],
      }),
    ]);
  });

  test("exact public repository fallback fails closed for private or unknown links", async () => {
    for (const message of ["GitHub API 404", "GitHub API 403", "private=true"]) {
      await expect(
        resolveRunIntake(
          {
            source: "api",
            text: "Run this generic repo https://github.com/octocat/Hello-World.git",
          },
          {
            authorize: createRunResourceAuthorization("org-1", {
              verifyPublicRepository: async () => {
                throw new Error(message);
              },
            }),
          },
        ),
      ).rejects.toMatchObject({ code: "resource_unauthorized" });
    }
  });

  test("uses org-scoped repository checks and pins a verified PR head", async () => {
    const calls: string[] = [];
    const intake = await resolveRunIntake(
      {
        source: "api",
        text: "Test https://github.com/upstream-org/backend/pull/19625",
      },
      {
        authorize: createRunResourceAuthorization("org-1", {
          async listRepos(orgId) {
            calls.push(`list:${orgId}`);
            return {
              configured: true,
              repos: [
                {
                  full_name: "upstream-org/backend",
                  name: "backend",
                  private: true,
                  default_branch: "main",
                },
              ],
            };
          },
          async unknownRepos(repos, orgId) {
            calls.push(`unknown:${orgId}:${repos.join(",")}`);
            return [];
          },
          async verifyPullRequest(repository, number) {
            calls.push(`pull:${repository}:${number}`);
            return { headSha: SHA };
          },
        }),
      },
    );

    expect(calls).toEqual([
      "list:org-1",
      "unknown:org-1:upstream-org/backend",
      "list:org-1",
      "unknown:org-1:upstream-org/backend",
      "pull:upstream-org/backend:19625",
    ]);
    expect(intake.repos).toEqual([]);
    expect(intake.resources[1]).toMatchObject({
      locator: { type: "github.pull_request", revision: SHA },
    });
  });

  test("rechecks inherited repository access without moving its pinned PR revision", async () => {
    const calls: string[] = [];
    const authorize = createRunResourceAuthorization("org-1", {
      async listRepos(orgId) {
        calls.push(`list:${orgId}`);
        return {
          configured: true,
          repos: [{
            full_name: "upstream-org/backend",
            name: "backend",
            private: true,
            default_branch: "main",
          }],
        };
      },
      async unknownRepos(repos, orgId) {
        calls.push(`unknown:${orgId}:${repos.join(",")}`);
        return [];
      },
      async verifyPullRequest(repository, number) {
        calls.push(`pull:${repository}:${number}`);
        return { headSha: SHA };
      },
    });
    const root = await resolveRunIntake(
      { source: "slack", text: "Test https://github.com/upstream-org/backend/pull/19625" },
      { authorize },
    );

    calls.length = 0;
    const followUp = await resolveRunIntake(
      { source: "slack", text: "Retest it", inheritedResources: root.resources },
      { authorize },
    );

    expect(calls).toEqual([
      "list:org-1",
      "unknown:org-1:upstream-org/backend",
      "list:org-1",
      "unknown:org-1:upstream-org/backend",
    ]);
    expect(followUp.resources[1]).toMatchObject({
      locator: { type: "github.pull_request", revision: SHA },
    });
    expect(followUp.repos).toEqual([]);
  });

  test("leaves ordinary web pages as prompt context without touching GitHub", async () => {
    const intake = await resolveRunIntake(
      { source: "web", text: "Read https://example.com/docs" },
      {
        authorize: createRunResourceAuthorization("org-1", {
          listRepos: async () => {
            throw new Error("GitHub should not be consulted");
          },
        }),
      },
    );
    expect(intake.resources).toEqual([]);
  });

  test("does not trust a caller-supplied PR revision", async () => {
    let verified = 0;
    const intake = await resolveRunIntake(
      {
        source: "api",
        text: "",
        explicitResources: [{
          kind: "code.change",
          provider: "github",
          locator: {
            type: "github.pull_request",
            repository: "upstream-org/backend",
            number: 19625,
            revision: "caller-controlled",
          },
        }],
      },
      {
        authorize: createRunResourceAuthorization("org-1", {
          listRepos: async () => ({ configured: true, repos: [] }),
          unknownRepos: async () => [],
          verifyPullRequest: async () => {
            verified += 1;
            return { headSha: SHA };
          },
        }),
      },
    );

    expect(verified).toBe(1);
    expect(intake.resources[0]).toMatchObject({
      locator: { type: "github.pull_request", revision: SHA },
    });
  });

  test("anonymous public repository API verification requires canonical public identity", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const request = input instanceof Request
        ? input
        : new Request(input.toString(), init);
      requests.push(request);
      return new Response(
        JSON.stringify({ full_name: "octocat/Hello-World", private: false }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      await verifyPublicGithubRepository("octocat/Hello-World");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://api.github.com/repos/octocat/Hello-World");
      expect(requests[0]?.headers.has("authorization")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("anonymous public repository API verification rejects private, 404, rate limit, and identity mismatch", async () => {
    const originalFetch = globalThis.fetch;
    const cases = [
      new Response(JSON.stringify({ full_name: "octocat/Hello-World", private: true }), {
        status: 200,
      }),
      new Response(JSON.stringify({ full_name: "octocat/Hello-World", private: false }), {
        status: 404,
      }),
      new Response(JSON.stringify({ message: "rate limit" }), { status: 403 }),
      new Response(JSON.stringify({ full_name: "other/Hello-World", private: false }), {
        status: 200,
      }),
    ];
    try {
      for (const response of cases) {
        globalThis.fetch = (async () => response.clone()) as unknown as typeof fetch;
        await expect(
          verifyPublicGithubRepository("octocat/Hello-World"),
        ).rejects.toThrow();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
