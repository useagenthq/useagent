import { afterEach, describe, expect, test } from "bun:test";
import { executeContextTool } from "./context-tools";
import { executeRepositoryTool } from "./repository-tools";
import { executeResourceTool } from "./resource-tools";
import { verifyToolToken, type ToolTokenClaims } from "./token";

const originalFetch = globalThis.fetch;
const originalGatewayDatabaseUrl = process.env.GATEWAY_DATABASE_URL;
const originalApiOrigin = process.env.USEAGENT_API_ORIGIN;
const originalToolGatewaySecret = process.env.TOOL_GATEWAY_SECRET;

const claims: ToolTokenClaims = {
  orgId: "org-a",
  userId: "user-a",
  threadId: "thread-a",
  runId: "run-a",
  scope: "run",
  exp: Date.now() + 60_000,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGatewayDatabaseUrl === undefined) delete process.env.GATEWAY_DATABASE_URL;
  else process.env.GATEWAY_DATABASE_URL = originalGatewayDatabaseUrl;
  if (originalApiOrigin === undefined) delete process.env.USEAGENT_API_ORIGIN;
  else process.env.USEAGENT_API_ORIGIN = originalApiOrigin;
  if (originalToolGatewaySecret === undefined) delete process.env.TOOL_GATEWAY_SECRET;
  else process.env.TOOL_GATEWAY_SECRET = originalToolGatewaySecret;
});

describe("GitHub-backed gateway delegation", () => {
  test("delegates clone, code context reads, and GitHub catalog search before local credential resolution", async () => {
    process.env.GATEWAY_DATABASE_URL = "postgres://restricted";
    process.env.USEAGENT_API_ORIGIN = "http://127.0.0.1:3201/path-is-ignored";
    process.env.TOOL_GATEWAY_SECRET = "github-backed-test-secret-0123456789";
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

    const calls = [
      executeRepositoryTool(claims, "github_clone_repository", {
        query: "upstream-org/backend",
      }),
      executeContextTool(claims, "context_read", {
        source_ref: "code:upstream-org/backend@abc123:src/index.ts#L10",
      }),
      executeResourceTool(claims, "resource_catalog_search", {
        provider: "github",
        query: "backend",
      }),
    ];
    for (const result of await Promise.all(calls)) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ delegated: true });
    }

    expect(requests).toHaveLength(3);
    expect(await Promise.all(requests.map((request) => request.json()))).toEqual([
      {
        family: "repository",
        name: "github_clone_repository",
        arguments: { query: "upstream-org/backend" },
      },
      {
        family: "context",
        name: "context_read",
        arguments: {
          source_ref: "code:upstream-org/backend@abc123:src/index.ts#L10",
        },
      },
      {
        family: "resource",
        name: "resource_catalog_search",
        arguments: { provider: "github", query: "backend" },
      },
    ]);
    for (const request of requests) {
      expect(request.url).toBe("http://127.0.0.1:3201/api/internal/github-operations");
      const authorization = request.headers.get("authorization") ?? "";
      expect(verifyToolToken(authorization.replace(/^Bearer\s+/, ""))).toMatchObject({
        orgId: "org-a",
        userId: "user-a",
        threadId: "thread-a",
        runId: "run-a",
        scope: "run",
      });
    }
  });

  test("all GitHub-backed paths fail closed when the restricted gateway has no primary origin", async () => {
    process.env.GATEWAY_DATABASE_URL = "postgres://restricted";
    delete process.env.USEAGENT_API_ORIGIN;

    const results = await Promise.all([
      executeRepositoryTool(claims, "github_clone_repository", {
        query: "upstream-org/backend",
      }),
      executeContextTool(claims, "context_read", {
        source_ref: "code:upstream-org/backend@abc123:src/index.ts#L10",
      }),
      executeResourceTool(claims, "resource_catalog_search", {
        provider: "github",
      }),
    ]);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("not configured");
    }
  });
});
