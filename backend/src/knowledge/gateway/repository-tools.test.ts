import { afterEach, describe, expect, test } from "bun:test";
import {
  executeRepositoryTool,
  repositoriesForRun,
  REPOSITORY_TOOLS,
  parsePublicGitHubUrl,
  resolveRepositoryCloneTarget,
  resolveRepositoryQuery,
  setRepositoryServiceForTest,
} from "./repository-tools";
import type { ToolTokenClaims } from "./token";
import type { RunResource } from "../../resources/types";

const repos = [
  {
    full_name: "upstream-org/backend",
    name: "backend",
    revision: "feature/auth",
  },
  {
    full_name: "upstream-org/frontend",
    name: "frontend",
    revision: null,
  },
  {
    full_name: "other/backend-tools",
    name: "backend-tools",
    revision: null,
  },
];

const claims: ToolTokenClaims = {
  orgId: "org-1",
  userId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  scope: "run",
  exp: Date.now() + 60_000,
};

const publicRepositoryResource: RunResource = {
  kind: "code.repository",
  provider: "github",
  locator: {
    type: "github.repository",
    repository: "octocat/Hello-World",
    revision: null,
  },
  capabilities: ["content.read", "code.checkout"],
  provenance: [{
    source: "user_text",
    channel: "api",
    raw: "https://github.com/octocat/Hello-World.git",
    start: 0,
    end: 41,
  }],
};

afterEach(() => setRepositoryServiceForTest(null));

describe("repository gateway tools", () => {
  test("advertises discover and clone tools without tenant or credential inputs", () => {
    expect(REPOSITORY_TOOLS.map((tool) => tool.name)).toEqual([
      "github_repositories",
      "github_clone_repository",
    ]);
    for (const tool of REPOSITORY_TOOLS) {
      const properties = Object.keys(tool.inputSchema.properties);
      expect(properties).not.toContain("token");
      expect(properties).not.toContain("orgId");
      expect(properties).not.toContain("destination");
    }
  });

  test("resolves only exact owner/name or a unique exact repository name", () => {
    expect(resolveRepositoryQuery(repos, "backend")?.full_name).toBe(
      "upstream-org/backend",
    );
    expect(resolveRepositoryQuery(repos, "upstream-org/frontend")?.full_name).toBe(
      "upstream-org/frontend",
    );
    expect(resolveRepositoryQuery(repos, "upstream-org/FRONTEND")?.full_name).toBe(
      "upstream-org/frontend",
    );
  });

  test("refuses fuzzy product phrases, ambiguous names, and unknown repositories", () => {
    expect(resolveRepositoryQuery(repos, "Acme backend")).toBeNull();
    expect(resolveRepositoryQuery(repos, "backend repo")).toBeNull();
    expect(resolveRepositoryQuery(repos, "upstream-org")).toBeNull();
    expect(resolveRepositoryQuery(repos, "payments-service")).toBeNull();
    expect(
      resolveRepositoryQuery([
        ...repos,
        {
          full_name: "other/backend",
          name: "backend",
          revision: null,
        },
      ], "backend"),
    ).toBeNull();
  });

  test("projects repositories directly from durable run bindings", () => {
    expect(
      repositoriesForRun(["upstream-org/backend:feature/auth"]),
    ).toEqual([{
      full_name: "upstream-org/backend",
      name: "backend",
      revision: "feature/auth",
    }]);
    expect(repositoriesForRun([], [{
      kind: "code.repository",
      provider: "github",
      locator: {
        type: "github.repository",
        repository: "upstream-org/frontend",
        revision: "release/next",
      },
      capabilities: ["content.read", "code.checkout"],
      provenance: [],
    }])).toEqual([{
      full_name: "upstream-org/frontend",
      name: "frontend",
      revision: "release/next",
    }]);
  });

  test("resolves private clones only from run-bound repos and marks exact public URLs anonymous", () => {
    expect(
      resolveRepositoryCloneTarget(
        ["upstream-org/backend:feature/auth"],
        "upstream-org/backend",
      ),
    ).toEqual({
      fullName: "upstream-org/backend",
      revision: "feature/auth",
      useGithubCredential: true,
    });
    expect(
      resolveRepositoryCloneTarget(["upstream-org/frontend"], "backend"),
    ).toBeNull();
    expect(
      resolveRepositoryCloneTarget(
        ["upstream-org/backend:feature/auth"],
        "Acme backend",
      ),
    ).toBeNull();
    expect(
      resolveRepositoryCloneTarget(
        [],
        "https://github.com/octocat/Hello-World",
      ),
    ).toBeNull();
    expect(
      resolveRepositoryCloneTarget(
        ["octocat/Hello-World"],
        "https://github.com/octocat/Hello-World.git",
        [publicRepositoryResource],
      ),
    ).toEqual({
      fullName: "octocat/Hello-World",
      revision: null,
      useGithubCredential: false,
    });
  });

  test("accepts only canonical public GitHub repository URLs", () => {
    expect(parsePublicGitHubUrl("https://github.com/octocat/Hello-World.git")).toBe(
      "octocat/Hello-World",
    );
    expect(parsePublicGitHubUrl("https://github.com/octocat/Hello-World/")).toBe(
      "octocat/Hello-World",
    );
    expect(parsePublicGitHubUrl("http://github.com/octocat/Hello-World")).toBeNull();
    expect(parsePublicGitHubUrl("https://evil.example/octocat/Hello-World")).toBeNull();
    expect(parsePublicGitHubUrl("https://github.com/octocat/Hello-World/issues")).toBeNull();
    expect(parsePublicGitHubUrl("https://user@github.com/octocat/Hello-World")).toBeNull();
  });

  test("clones a resolved repository into the fixed sandbox workspace", async () => {
    setRepositoryServiceForTest({
      list: async () => repos,
      clone: async (_claims, query, branch) => {
        expect(query).toBe("upstream-org/backend");
        expect(branch).toBeNull();
        return {
          repository: "upstream-org/backend",
          branch: "main",
          commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
          path: "/root/work/upstream-org/backend",
        };
      },
    });

    const response = await executeRepositoryTool(claims, "github_clone_repository", {
      query: "upstream-org/backend",
    });
    expect(response.isError).toBeUndefined();
    expect(response.content[0]?.text).toContain("/root/work/upstream-org/backend");
    expect(response.structuredContent).toEqual({
      repository: "upstream-org/backend",
      branch: "main",
      commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
      path: "/root/work/upstream-org/backend",
    });
  });

  test("passes signed run claims into repository discovery", async () => {
    setRepositoryServiceForTest({
      list: async (receivedClaims, query) => {
        expect(receivedClaims).toEqual(claims);
        expect(query).toBe("backend");
        return [repos[0]!];
      },
      clone: async () => {
        throw new Error("not used");
      },
    });

    const response = await executeRepositoryTool(claims, "github_repositories", {
      query: "backend",
    });
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual({ repositories: [repos[0]!] });
  });
});
