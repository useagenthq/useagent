import { afterEach, describe, expect, test } from "bun:test";
import {
  executeGithubTool,
  GITHUB_TOOLS,
  setGithubReadServiceForTest,
  type GithubReadService,
} from "./github-tools";
import { baseGatewayToolDescriptors } from "./operation-registry";
import type { ToolTokenClaims } from "./token";

const claims: ToolTokenClaims = {
  orgId: "org-1",
  userId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  scope: "run",
  exp: Date.now() + 60_000,
};

const BOUND = ["upstream-org/backend", "upstream-org/frontend"];

function mockGithub(
  responses: Record<string, unknown> = {},
  bound: string[] = BOUND,
): { fetched: string[]; boundCalls: number } {
  const state = { fetched: [] as string[], boundCalls: 0 };
  const service: GithubReadService = {
    async boundRepos(tokenClaims) {
      expect(tokenClaims).toBe(claims);
      state.boundCalls += 1;
      return bound;
    },
    async fetchJson(path) {
      state.fetched.push(path);
      if (!(path in responses)) throw new Error("GitHub API 404");
      return responses[path];
    },
  };
  setGithubReadServiceForTest(service);
  return state;
}

afterEach(() => setGithubReadServiceForTest(null));

describe("github gateway tool catalog", () => {
  test("advertises the read-only PR and issue tools without tenant or credential inputs", () => {
    expect(GITHUB_TOOLS.map((tool) => tool.name)).toEqual([
      "github_list_prs",
      "github_pr_detail",
      "github_list_issues",
    ]);
    for (const tool of GITHUB_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      const properties = Object.keys(tool.inputSchema.properties);
      expect(properties).not.toContain("token");
      expect(properties).not.toContain("orgId");
      expect(tool.inputSchema.required).toContain("repo");
    }
  });

  test("is registered in the always-available gateway catalog", () => {
    const names = baseGatewayToolDescriptors().map((tool) => tool.name);
    expect(names).toContain("github_list_prs");
    expect(names).toContain("github_pr_detail");
    expect(names).toContain("github_list_issues");
  });
});

describe("repo binding", () => {
  test("rejects a repository outside the run's bound set without fetching", async () => {
    const mock = mockGithub();
    const response = await executeGithubTool(claims, "github_list_prs", {
      repo: "upstream-org/other-service",
    });
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain('"upstream-org/other-service" is not bound');
    expect(response.content[0]?.text).toContain("upstream-org/backend, upstream-org/frontend");
    expect(mock.fetched).toEqual([]);
  });

  test("rejects when the run has no bound repositories", async () => {
    const mock = mockGithub({}, []);
    const response = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("no bound repositories");
    expect(mock.fetched).toEqual([]);
  });

  test("rejects a malformed repo before consulting the run binding", async () => {
    const mock = mockGithub();
    const response = await executeGithubTool(claims, "github_list_issues", {
      repo: "https://github.com/upstream-org/backend",
    });
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("owner/name");
    expect(mock.boundCalls).toBe(0);
  });

  test("resolves a case-insensitive match to the canonical bound name", async () => {
    const mock = mockGithub({
      "/repos/upstream-org/backend/pulls?state=open&sort=updated&direction=desc&per_page=20": [],
    });
    const response = await executeGithubTool(claims, "github_list_prs", {
      repo: "upstream-org/BACKEND",
    });
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent?.repository).toBe("upstream-org/backend");
    expect(mock.fetched).toHaveLength(1);
  });
});

describe("github_list_prs", () => {
  test("returns bounded PR summaries with the default limit", async () => {
    const mock = mockGithub({
      "/repos/upstream-org/backend/pulls?state=open&sort=updated&direction=desc&per_page=20": [
        {
          number: 42,
          title: "Add retry lane",
          state: "open",
          draft: true,
          html_url: "https://github.com/upstream-org/backend/pull/42",
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-02T00:00:00Z",
          user: { login: "octocat" },
          head: { ref: "feat/retry" },
          base: { ref: "main" },
        },
      ],
    });
    const response = await executeGithubTool(claims, "github_list_prs", {
      repo: "upstream-org/backend",
    });
    expect(response.isError).toBeUndefined();
    expect(response.content[0]?.text).toContain("#42 [open, draft] Add retry lane (octocat)");
    expect(response.structuredContent).toEqual({
      repository: "upstream-org/backend",
      state: "open",
      pull_requests: [
        {
          number: 42,
          title: "Add retry lane",
          state: "open",
          draft: true,
          author: "octocat",
          head: "feat/retry",
          base: "main",
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-02T00:00:00Z",
          url: "https://github.com/upstream-org/backend/pull/42",
        },
      ],
    });
    expect(mock.fetched).toEqual([
      "/repos/upstream-org/backend/pulls?state=open&sort=updated&direction=desc&per_page=20",
    ]);
  });

  test("caps an oversized limit at 50 and honors the state filter", async () => {
    const path =
      "/repos/upstream-org/backend/pulls?state=closed&sort=updated&direction=desc&per_page=50";
    const mock = mockGithub({
      [path]: Array.from({ length: 60 }, (_, i) => ({ number: i + 1 })),
    });
    const response = await executeGithubTool(claims, "github_list_prs", {
      repo: "upstream-org/backend",
      state: "closed",
      limit: 500,
    });
    expect(response.isError).toBeUndefined();
    expect(mock.fetched).toEqual([path]);
    const pulls = response.structuredContent?.pull_requests as unknown[];
    expect(pulls).toHaveLength(50);
  });

  test("rejects an unknown state and a non-integer limit", async () => {
    mockGithub();
    const badState = await executeGithubTool(claims, "github_list_prs", {
      repo: "upstream-org/backend",
      state: "merged",
    });
    expect(badState.isError).toBe(true);
    expect(badState.content[0]?.text).toContain("state must be one of open, closed, or all");

    const badLimit = await executeGithubTool(claims, "github_list_prs", {
      repo: "upstream-org/backend",
      limit: 2.5,
    });
    expect(badLimit.isError).toBe(true);
    expect(badLimit.content[0]?.text).toContain("limit must be a positive integer");
  });
});

describe("github_pr_detail", () => {
  test("returns a bounded detail summary with truncated body and files", async () => {
    const longBody = "x".repeat(5_000);
    mockGithub({
      "/repos/upstream-org/backend/pulls/7": {
        number: 7,
        title: "Harden retries",
        state: "closed",
        merged: true,
        body: longBody,
        html_url: "https://github.com/upstream-org/backend/pull/7",
        user: { login: "octocat" },
        head: { ref: "fix/retries" },
        base: { ref: "main" },
        merged_at: "2026-08-03T00:00:00Z",
        commits: 3,
        additions: 120,
        deletions: 40,
        changed_files: 80,
      },
      "/repos/upstream-org/backend/pulls/7/files?per_page=50": Array.from(
        { length: 50 },
        (_, i) => ({ filename: `src/file-${i}.ts`, status: "modified", additions: 2, deletions: 1 }),
      ),
    });
    const response = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });
    expect(response.isError).toBeUndefined();
    const summary = response.structuredContent as Record<string, unknown>;
    expect(summary.number).toBe(7);
    expect(summary.merged).toBe(true);
    expect(summary.body_truncated).toBe(true);
    expect((summary.body as string).length).toBeLessThan(longBody.length);
    expect(summary.body as string).toContain("[body truncated]");
    expect(summary.files).toHaveLength(50);
    expect(summary.changed_files).toBe(80);
    expect(summary.files_truncated).toBe(true);
    expect(response.content[0]?.text).toContain("PR #7 Harden retries");
    expect(response.content[0]?.text).toContain("80 files changed (+120 -40), first 50 listed");
  });

  test("requires a positive integer pull request number", async () => {
    const mock = mockGithub();
    const response = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: "seven",
    });
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("positive pull request number");
    expect(mock.fetched).toEqual([]);
  });
});

describe("github_list_issues", () => {
  test("excludes pull requests, maps labels, and applies the limit", async () => {
    mockGithub({
      "/repos/upstream-org/frontend/issues?state=all&sort=updated&direction=desc&per_page=100": [
        {
          number: 3,
          title: "PR disguised as issue",
          state: "open",
          pull_request: { url: "https://api.github.com/..." },
        },
        {
          number: 2,
          title: "Broken layout",
          state: "open",
          comments: 4,
          user: { login: "reporter" },
          labels: [{ name: "bug" }, "ui", { name: null }],
          html_url: "https://github.com/upstream-org/frontend/issues/2",
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-02T00:00:00Z",
        },
        { number: 1, title: "Old question", state: "closed" },
      ],
    });
    const response = await executeGithubTool(claims, "github_list_issues", {
      repo: "upstream-org/frontend",
      state: "all",
      limit: 1,
    });
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual({
      repository: "upstream-org/frontend",
      state: "all",
      issues: [
        {
          number: 2,
          title: "Broken layout",
          state: "open",
          author: "reporter",
          labels: ["bug", "ui"],
          comments: 4,
          created_at: "2026-08-01T00:00:00Z",
          updated_at: "2026-08-02T00:00:00Z",
          url: "https://github.com/upstream-org/frontend/issues/2",
        },
      ],
    });
    expect(response.content[0]?.text).toContain("#2 [open] Broken layout (reporter) [bug, ui]");
  });
});

describe("failure handling", () => {
  test("surfaces a GitHub API failure as a tool error, never a throw", async () => {
    mockGithub({});
    const response = await executeGithubTool(claims, "github_list_prs", {
      repo: "upstream-org/backend",
    });
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("GitHub API 404");
  });

  test("rejects an unknown tool name", async () => {
    mockGithub();
    const response = await executeGithubTool(claims, "github_delete_repo", {});
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("Unknown GitHub tool");
  });
});
