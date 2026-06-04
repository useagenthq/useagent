import { afterEach, describe, expect, test } from "bun:test";
import {
  boundGithubRepositories,
  executeGithubTool,
  GITHUB_TOOLS,
  setGithubReadServiceForTest,
  type GithubPullRequestGrant,
  type GithubReadService,
} from "./github-tools";
import { baseGatewayToolDescriptors } from "./operation-registry";
import { resolveRunIntake } from "../../resources/run-intake";
import { verifyToolToken, type ToolTokenClaims } from "./token";

const claims: ToolTokenClaims = {
  orgId: "org-1",
  userId: "user-1",
  threadId: "thread-1",
  runId: "run-1",
  scope: "run",
  exp: Date.now() + 60_000,
};

const BOUND = ["upstream-org/backend", "upstream-org/frontend"];
const originalGithubTenantOrgId = process.env.GITHUB_TENANT_ORG_ID;
const originalFetch = globalThis.fetch;
const originalGatewayDatabaseUrl = process.env.GATEWAY_DATABASE_URL;
const originalApiOrigin = process.env.USEAGENT_API_ORIGIN;
const originalToolGatewaySecret = process.env.TOOL_GATEWAY_SECRET;

function mockGithub(
  responses: Record<string, unknown> = {},
  bound: string[] = BOUND,
  grants: readonly GithubPullRequestGrant[] = [{
      repository: "upstream-org/backend",
      number: 7,
      revision: "abc123",
      capabilities: ["change.read", "change.checks.read", "deployment.read"],
    }],
): { fetched: string[]; boundCalls: number; grantCalls: number } {
  const state = { fetched: [] as string[], boundCalls: 0, grantCalls: 0 };
  const service: GithubReadService = {
    async boundRepos(tokenClaims) {
      expect(tokenClaims).toBe(claims);
      state.boundCalls += 1;
      return bound;
    },
    async pullRequestGrants(tokenClaims) {
      expect(tokenClaims).toBe(claims);
      state.grantCalls += 1;
      return grants;
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

afterEach(() => {
  setGithubReadServiceForTest(null);
  globalThis.fetch = originalFetch;
  if (originalGithubTenantOrgId === undefined) delete process.env.GITHUB_TENANT_ORG_ID;
  else process.env.GITHUB_TENANT_ORG_ID = originalGithubTenantOrgId;
  if (originalGatewayDatabaseUrl === undefined) delete process.env.GATEWAY_DATABASE_URL;
  else process.env.GATEWAY_DATABASE_URL = originalGatewayDatabaseUrl;
  if (originalApiOrigin === undefined) delete process.env.USEAGENT_API_ORIGIN;
  else process.env.USEAGENT_API_ORIGIN = originalApiOrigin;
  if (originalToolGatewaySecret === undefined) delete process.env.TOOL_GATEWAY_SECRET;
  else process.env.TOOL_GATEWAY_SECRET = originalToolGatewaySecret;
});

describe("github gateway tool catalog", () => {
  test("advertises the read-only PR and issue tools without tenant or credential inputs", () => {
    const readTools = GITHUB_TOOLS.slice(0, 3);
    expect(readTools.map((tool) => tool.name)).toEqual([
      "github_list_prs",
      "github_pr_detail",
      "github_list_issues",
    ]);
    for (const tool of readTools) {
      expect(tool.description.length).toBeGreaterThan(0);
      const schema = tool.inputSchema as {
        readonly properties: Readonly<Record<string, unknown>>;
        readonly required: readonly string[];
      };
      const properties = Object.keys(schema.properties);
      expect(properties).not.toContain("token");
      expect(properties).not.toContain("orgId");
      expect(schema.required).toContain("repo");
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
  test("a resolved PR URL does not widen into repository-wide reads", async () => {
    const intake = await resolveRunIntake(
      {
        source: "api",
        text: "Review https://github.com/upstream-org/backend/pull/7",
      },
      { authorize: () => true },
    );
    expect(intake.resources).toHaveLength(2);
    expect(boundGithubRepositories({
      repos: intake.repos,
      resolvedResources: intake.resources,
    })).toEqual([]);
  });

  test("rejects another product org before every production GitHub read path", async () => {
    setGithubReadServiceForTest(null);
    process.env.GITHUB_TENANT_ORG_ID = "org-primary";

    for (const [name, args] of [
      ["github_list_prs", { repo: "upstream-org/backend" }],
      ["github_list_issues", { repo: "upstream-org/backend" }],
      ["github_pr_detail", { repo: "upstream-org/backend", number: 7 }],
    ] as const) {
      const response = await executeGithubTool(
        { ...claims, orgId: "org-other" },
        name,
        args,
      );
      expect(response.isError).toBe(true);
      expect(response.content[0]?.text).toContain(
        "GitHub repository access is not available to this organization",
      );
    }
  });

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
    const response = await executeGithubTool(claims, "github_list_prs", {
      repo: "upstream-org/backend",
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
  test("uses an exact PR grant without broadening it to repository-wide reads", async () => {
    mockGithub(
      {
        "/repos/upstream-org/backend/pulls/7": {
          number: 7,
          title: "Read through the exact grant",
          state: "open",
          head: { ref: "feature", sha: "abc123" },
          base: { ref: "main" },
        },
        "/repos/upstream-org/backend/pulls/7/files?per_page=50": [],
      },
      [],
    );

    const detail = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });
    expect(detail.isError).toBeUndefined();

    const list = await executeGithubTool(claims, "github_list_prs", {
      repo: "upstream-org/backend",
    });
    expect(list.isError).toBe(true);
    expect(list.content[0]?.text).toContain("no bound repositories");
  });

  test("requires an exact persisted PR grant, not only a bound repository", async () => {
    const mock = mockGithub({}, BOUND, []);
    const response = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("is not authorized for this run");
    expect(mock.fetched).toEqual([]);
  });

  test("requires the pinned revision and every PR-detail capability", async () => {
    const withoutRevision = mockGithub({}, BOUND, [{
      repository: "upstream-org/backend",
      number: 7,
      revision: null,
      capabilities: ["change.read", "change.checks.read", "deployment.read"],
    }]);
    const missingRevision = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });
    expect(missingRevision.isError).toBe(true);
    expect(missingRevision.content[0]?.text).toContain("no pinned authorized revision");
    expect(withoutRevision.fetched).toEqual([]);

    const withoutDeployment = mockGithub({}, BOUND, [{
      repository: "upstream-org/backend",
      number: 7,
      revision: "abc123",
      capabilities: ["change.read", "change.checks.read"],
    }]);
    const missingCapability = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });
    expect(missingCapability.isError).toBe(true);
    expect(missingCapability.content[0]?.text).toContain("deployment.read");
    expect(withoutDeployment.fetched).toEqual([]);
  });

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
        head: { ref: "fix/retries", sha: "abc123" },
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
    expect(response.content[0]?.text).toContain("fix/retries @ abc123 -> main");
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

  test("returns bounded check runs, HTTPS summary links, and legacy commit statuses", async () => {
    const oversizedSummary =
      "Open [browser preview](https://preview.example.test/pr-7).\n" +
      "x".repeat(2_100) +
      "\n[insecure fallback](http://preview.example.test/pr-7).";
    mockGithub({
      "/repos/upstream-org/backend/pulls/7": {
        number: 7,
        title: "Ship preview",
        state: "open",
        head: { ref: "feat/preview", sha: "abc123" },
        base: { ref: "main" },
      },
      "/repos/upstream-org/backend/pulls/7/files?per_page=50": [],
      "/repos/upstream-org/backend/commits/abc123/check-runs?per_page=50": {
        total_count: 2,
        check_runs: [
          {
            name: "build",
            status: "completed",
            conclusion: "success",
            details_url: "https://github.com/upstream-org/backend/actions/runs/10",
            started_at: "2026-08-20T10:00:00Z",
            completed_at: "2026-08-20T10:03:00Z",
            app: { slug: "github-actions" },
          },
          {
            name: "preview smoke",
            status: "in_progress",
            conclusion: null,
            details_url: "https://checks.example.test/preview",
            started_at: "2026-08-20T10:01:00Z",
            completed_at: null,
            app: { slug: "preview-bot" },
            output: {
              title: "Preview ready",
              summary: oversizedSummary,
            },
          },
        ],
      },
      "/repos/upstream-org/backend/deployments?sha=abc123&per_page=30": [],
      "/repos/upstream-org/backend/commits/abc123/status?per_page=50": {
        state: "pending",
        total_count: 1,
        statuses: [
          {
            id: 500,
            context: "legacy/preview",
            state: "pending",
            description: "Preview is starting",
            target_url: "https://legacy-checks.example.test/500",
            creator: { login: "legacy-bot" },
          },
        ],
      },
    });

    const response = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({
      head_sha: "abc123",
      check_runs: [
        {
          name: "build",
          status: "completed",
          conclusion: "success",
          details_url: "https://github.com/upstream-org/backend/actions/runs/10",
          app: "github-actions",
        },
        {
          name: "preview smoke",
          status: "in_progress",
          conclusion: null,
          details_url: "https://checks.example.test/preview",
          app: "preview-bot",
          output_title: "Preview ready",
          output_summary_truncated: true,
          links: [{ label: "browser preview", url: "https://preview.example.test/pr-7" }],
        },
      ],
      check_runs_total: 2,
      check_runs_truncated: false,
      check_runs_available: true,
      check_runs_error: null,
      commit_status_state: "pending",
      commit_statuses: [
        {
          id: 500,
          context: "legacy/preview",
          state: "pending",
          description: "Preview is starting",
          target_url: "https://legacy-checks.example.test/500",
          creator: "legacy-bot",
        },
      ],
      commit_statuses_available: true,
      commit_statuses_error: null,
    });
    const checkRuns = response.structuredContent?.check_runs as Array<Record<string, unknown>>;
    expect(checkRuns[1]?.output_summary as string).toContain("[summary truncated]");
    expect((checkRuns[1]?.output_summary as string).length).toBeLessThan(oversizedSummary.length);
  });

  test("requests independent head-revision evidence in parallel", async () => {
    const checks = Promise.withResolvers<unknown>();
    const deployments = Promise.withResolvers<unknown>();
    const statuses = Promise.withResolvers<unknown>();
    const started: string[] = [];
    setGithubReadServiceForTest({
      async boundRepos() {
        return BOUND;
      },
      async pullRequestGrants() {
        return [{
          repository: "upstream-org/backend",
          number: 7,
          revision: "abc123",
          capabilities: ["change.read", "change.checks.read", "deployment.read"],
        }];
      },
      async fetchJson(path) {
        if (path === "/repos/upstream-org/backend/pulls/7") {
          return {
            number: 7,
            title: "Parallel evidence",
            head: { ref: "feat/preview", sha: "abc123" },
            base: { ref: "main" },
          };
        }
        if (path === "/repos/upstream-org/backend/pulls/7/files?per_page=50") return [];
        if (path.includes("/check-runs")) {
          started.push("checks");
          return await checks.promise;
        }
        if (path.includes("/deployments?")) {
          started.push("deployments");
          return await deployments.promise;
        }
        if (path.includes("/status?")) {
          started.push("statuses");
          return await statuses.promise;
        }
        throw new Error(`unexpected path: ${path}`);
      },
    });

    const responsePromise = executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });
    await Bun.sleep(0);

    expect(started.toSorted()).toEqual(["checks", "deployments", "statuses"]);
    checks.resolve({ total_count: 0, check_runs: [] });
    deployments.resolve([]);
    statuses.resolve({ state: "pending", total_count: 0, statuses: [] });
    expect((await responsePromise).isError).toBeUndefined();
  });

  test("returns every deployment environment and its latest status", async () => {
    mockGithub({
      "/repos/upstream-org/backend/pulls/7": {
        number: 7,
        title: "Ship preview",
        state: "open",
        head: { ref: "feat/preview", sha: "abc123" },
        base: { ref: "main" },
      },
      "/repos/upstream-org/backend/pulls/7/files?per_page=50": [],
      "/repos/upstream-org/backend/commits/abc123/check-runs?per_page=50": {
        total_count: 0,
        check_runs: [],
      },
      "/repos/upstream-org/backend/commits/abc123/status?per_page=50": {
        state: "success",
        total_count: 0,
        statuses: [],
      },
      "/repos/upstream-org/backend/deployments?sha=abc123&per_page=30": [
        {
          id: 101,
          environment: "Primary",
          description: "Primary deployment",
          ref: "feat/preview",
          sha: "abc123",
          created_at: "2026-08-20T10:00:00Z",
          updated_at: "2026-08-20T10:03:00Z",
        },
        {
          id: 102,
          environment: "Browser preview",
          description: "PR browser-test deployment",
          ref: "feat/preview",
          sha: "abc123",
          created_at: "2026-08-20T10:01:00Z",
          updated_at: "2026-08-20T10:04:00Z",
        },
      ],
      "/repos/upstream-org/backend/deployments/101/statuses?per_page=1": [
        {
          state: "success",
          environment_url: "https://primary.example.test",
          log_url: "https://deploy.example.test/101",
          created_at: "2026-08-20T10:03:00Z",
          updated_at: "2026-08-20T10:03:00Z",
        },
      ],
      "/repos/upstream-org/backend/deployments/102/statuses?per_page=1": [
        {
          state: "success",
          environment_url: "https://pr-7.preview.example.test",
          log_url: "https://deploy.example.test/102",
          created_at: "2026-08-20T10:04:00Z",
          updated_at: "2026-08-20T10:04:00Z",
        },
      ],
    });

    const response = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({
      deployments: [
        {
          id: 101,
          environment: "Primary",
          state: "success",
          environment_url: "https://primary.example.test",
          status_available: true,
          status_error: null,
        },
        {
          id: 102,
          environment: "Browser preview",
          state: "success",
          environment_url: "https://pr-7.preview.example.test",
          status_available: true,
          status_error: null,
        },
      ],
      deployments_truncated: false,
      deployments_available: true,
      deployments_error: null,
    });
    expect(response.content[0]?.text).toContain("Primary: success https://primary.example.test");
    expect(response.content[0]?.text).toContain(
      "Browser preview: success https://pr-7.preview.example.test",
    );
  });

  test("bounds concurrent deployment-status requests", async () => {
    let active = 0;
    let maxActive = 0;
    const deployments = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      environment: `preview-${index + 1}`,
      sha: "abc123",
    }));
    setGithubReadServiceForTest({
      async boundRepos() {
        return BOUND;
      },
      async pullRequestGrants() {
        return [{
          repository: "upstream-org/backend",
          number: 7,
          revision: "abc123",
          capabilities: ["change.read", "change.checks.read", "deployment.read"],
        }];
      },
      async fetchJson(path) {
        if (path === "/repos/upstream-org/backend/pulls/7") {
          return { number: 7, title: "Bounded", head: { ref: "feat/x", sha: "abc123" } };
        }
        if (path === "/repos/upstream-org/backend/pulls/7/files?per_page=50") return [];
        if (path.includes("/check-runs")) return { total_count: 0, check_runs: [] };
        if (path.includes("/status?")) return { state: "success", total_count: 0, statuses: [] };
        if (path.includes("/deployments?")) return deployments;
        if (/\/deployments\/\d+\/statuses/.test(path)) {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Bun.sleep(5);
          active -= 1;
          return [{ state: "success" }];
        }
        throw new Error(`unexpected path: ${path}`);
      },
    });

    const response = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });
    expect(response.isError).toBeUndefined();
    expect((response.structuredContent?.deployments as unknown[]).length).toBe(12);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(maxActive).toBeGreaterThan(1);
  });

  test("keeps base PR detail when every optional evidence API is unavailable", async () => {
    mockGithub({
      "/repos/upstream-org/backend/pulls/7": {
        number: 7,
        title: "Still readable",
        state: "open",
        head: { ref: "feat/preview", sha: "abc123" },
        base: { ref: "main" },
      },
      "/repos/upstream-org/backend/pulls/7/files?per_page=50": [],
    });

    const response = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({
      title: "Still readable",
      check_runs: [],
      check_runs_available: false,
      check_runs_error: "GitHub API 404",
      deployments: [],
      deployments_available: false,
      deployments_error: "GitHub API 404",
      commit_statuses: [],
      commit_statuses_available: false,
      commit_statuses_error: "GitHub API 404",
    });
    expect(response.content[0]?.text).toContain("Check runs unavailable: GitHub API 404");
    expect(response.content[0]?.text).toContain("Deployments unavailable: GitHub API 404");
    expect(response.content[0]?.text).toContain("Commit statuses unavailable: GitHub API 404");
  });

  test("rejects detail when GitHub no longer returns the authorized head SHA", async () => {
    const mock = mockGithub({
      "/repos/upstream-org/backend/pulls/7": {
        number: 7,
        title: "Missing revision",
        state: "open",
        head: { ref: "feat/preview" },
        base: { ref: "main" },
      },
      "/repos/upstream-org/backend/pulls/7/files?per_page=50": [],
    });

    const response = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("no longer matches its authorized revision");
    expect(mock.fetched).toEqual(["/repos/upstream-org/backend/pulls/7"]);
  });

  test("reports a failed latest deployment status without hiding the deployment", async () => {
    mockGithub({
      "/repos/upstream-org/backend/pulls/7": {
        number: 7,
        title: "Partial deployment evidence",
        state: "open",
        head: { ref: "feat/preview", sha: "abc123" },
        base: { ref: "main" },
      },
      "/repos/upstream-org/backend/pulls/7/files?per_page=50": [],
      "/repos/upstream-org/backend/commits/abc123/check-runs?per_page=50": {
        total_count: 0,
        check_runs: [],
      },
      "/repos/upstream-org/backend/commits/abc123/status?per_page=50": {
        state: "pending",
        total_count: 0,
        statuses: [],
      },
      "/repos/upstream-org/backend/deployments?sha=abc123&per_page=30": [
        { id: 101, environment: "Browser preview", sha: "abc123" },
      ],
    });

    const response = await executeGithubTool(claims, "github_pr_detail", {
      repo: "upstream-org/backend",
      number: 7,
    });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({
      deployments_available: true,
      deployments_error: null,
      deployments: [
        {
          id: 101,
          environment: "Browser preview",
          state: null,
          status_available: false,
          status_error: "GitHub API 404",
        },
      ],
    });
    expect(response.content[0]?.text).toContain("Browser preview: status unavailable (GitHub API 404)");
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

describe("GitHub gateway control-plane delegation", () => {
  test("forwards every GitHub tool through the primary API with a short-lived identity-bound capability", async () => {
    process.env.GATEWAY_DATABASE_URL = "postgres://restricted";
    process.env.USEAGENT_API_ORIGIN = "http://127.0.0.1:3201/path-is-ignored";
    process.env.TOOL_GATEWAY_SECRET = "github-test-secret-0123456789abcdef";
    const requests: Request[] = [];
    globalThis.fetch = (async (input, init) => {
      requests.push(input instanceof Request ? input : new Request(input.toString(), init));
      return Response.json({
        result: {
          content: [{ type: "text", text: "delegated" }],
          structuredContent: { delegated: true },
        },
      });
    }) as typeof fetch;

    for (const [name, args] of [
      ["github_list_prs", { repo: "upstream-org/backend" }],
      ["github_pr_detail", { repo: "upstream-org/backend", number: 7 }],
      ["github_list_issues", { repo: "upstream-org/backend", state: "all" }],
    ] as const) {
      const result = await executeGithubTool(claims, name, args);
      expect(result.isError).not.toBe(true);
    }

    expect(requests).toHaveLength(3);
    for (const [index, request] of requests.entries()) {
      expect(request.url).toBe("http://127.0.0.1:3201/api/internal/github-operations");
      const authorization = request.headers.get("authorization") ?? "";
      const forwarded = verifyToolToken(authorization.replace(/^Bearer\s+/, ""));
      expect(forwarded).toMatchObject({
        orgId: "org-1",
        userId: "user-1",
        threadId: "thread-1",
        runId: "run-1",
        scope: "run",
      });
      expect((forwarded?.exp ?? 0) - Date.now()).toBeLessThanOrEqual(30_000);
      expect(await request.json()).toEqual({
        family: "github",
        name: ["github_list_prs", "github_pr_detail", "github_list_issues"][index],
        arguments: [
          { repo: "upstream-org/backend" },
          { repo: "upstream-org/backend", number: 7 },
          { repo: "upstream-org/backend", state: "all" },
        ][index],
      });
    }
  });

  test("fails closed when a restricted gateway has no primary API origin", async () => {
    process.env.GATEWAY_DATABASE_URL = "postgres://restricted";
    delete process.env.USEAGENT_API_ORIGIN;
    const result = await executeGithubTool(claims, "github_list_prs", {
      repo: "upstream-org/backend",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not configured");
  });
});
