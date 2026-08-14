import { afterEach, describe, expect, test } from "bun:test";
import type { RepoInfo } from "../../github/repos";
import {
  executeRepositoryTool,
  REPOSITORY_TOOLS,
  parsePublicGitHubUrl,
  resolveRepositoryQuery,
  setRepositoryServiceForTest,
} from "./repository-tools";
import type { ToolTokenClaims } from "./token";

const repos: RepoInfo[] = [
  {
    full_name: "upstream-org/backend",
    name: "backend",
    private: true,
    default_branch: "main",
  },
  {
    full_name: "upstream-org/frontend",
    name: "frontend",
    private: true,
    default_branch: "main",
  },
  {
    full_name: "other/backend-tools",
    name: "backend-tools",
    private: false,
    default_branch: "master",
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

  test("resolves natural Acme aliases to an exact accessible repository", () => {
    expect(resolveRepositoryQuery(repos, "Acme backend")?.full_name).toBe(
      "upstream-org/backend",
    );
    expect(resolveRepositoryQuery(repos, "backend repo")?.full_name).toBe(
      "upstream-org/backend",
    );
    expect(resolveRepositoryQuery(repos, "upstream-org/frontend")?.full_name).toBe(
      "upstream-org/frontend",
    );
  });

  test("refuses an ambiguous or unknown repository query", () => {
    expect(resolveRepositoryQuery(repos, "upstream-org")).toBeNull();
    expect(resolveRepositoryQuery(repos, "payments-service")).toBeNull();
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
        expect(query).toBe("Acme backend");
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
      query: "Acme backend",
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
});
