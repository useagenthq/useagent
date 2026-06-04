import { afterEach, describe, expect, test } from "bun:test";
import { createInternalGithubRoutes } from "./github-internal-routes";
import { mintToolToken, type ToolTokenClaims } from "./token";

const originalToolGatewaySecret = process.env.TOOL_GATEWAY_SECRET;

afterEach(() => {
  if (originalToolGatewaySecret === undefined) delete process.env.TOOL_GATEWAY_SECRET;
  else process.env.TOOL_GATEWAY_SECRET = originalToolGatewaySecret;
});

describe("internal GitHub tool bridge", () => {
  test("rejects requests without a signed run capability", async () => {
    const response = await createInternalGithubRoutes({
      resolveIdentity: async () => null,
      executeLocal: async () => ({ content: [{ type: "text", text: "unexpected" }] }),
    }).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        family: "github",
        name: "github_list_prs",
        arguments: { repo: "upstream-org/backend" },
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  test("revalidates the live run and executes locally with the resolved identity", async () => {
    process.env.TOOL_GATEWAY_SECRET = "github-route-test-secret-0123456789";
    const tokenClaims: ToolTokenClaims = {
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-a",
      runId: "stale-run",
      scope: "thread",
      exp: Date.now() + 60_000,
    };
    const liveClaims = { ...tokenClaims, runId: "live-run" };
    let resolvedClaims: ToolTokenClaims | null = null;
    const executedClaims: ToolTokenClaims[] = [];
    const routes = createInternalGithubRoutes({
      resolveIdentity: async (claims) => {
        resolvedClaims = claims;
        return liveClaims;
      },
      executeLocal: async (family, claims, name, args) => {
        expect(family).toBe("github");
        executedClaims.push(claims);
        expect(name).toBe("github_list_issues");
        expect(args).toEqual({ repo: "upstream-org/backend" });
        return { content: [{ type: "text", text: "local result" }] };
      },
    });

    const response = await routes.request("/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${mintToolToken(tokenClaims, 60_000)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        family: "github",
        name: "github_list_issues",
        arguments: { repo: "upstream-org/backend" },
      }),
    });

    expect(response.status).toBe(200);
    expect(resolvedClaims).toMatchObject({ runId: "stale-run", scope: "thread" });
    expect(executedClaims).toEqual([liveClaims]);
    expect(await response.json()).toEqual({
      result: { content: [{ type: "text", text: "local result" }] },
    });
  });

  test("admits the credential-backed repository, code-context, and GitHub catalog operation shapes", async () => {
    process.env.TOOL_GATEWAY_SECRET = "github-route-test-secret-0123456789";
    const liveClaims: ToolTokenClaims = {
      orgId: "org-a",
      userId: "user-a",
      threadId: "thread-a",
      runId: "run-a",
      scope: "run",
      exp: Date.now() + 60_000,
    };
    const calls: Array<{ family: string; name: string; args: Record<string, unknown> }> = [];
    const routes = createInternalGithubRoutes({
      resolveIdentity: async () => liveClaims,
      executeLocal: async (family, _claims, name, args) => {
        calls.push({ family, name, args });
        return { content: [{ type: "text", text: "local result" }] };
      },
    });
    const operations = [
      {
        family: "repository",
        name: "github_clone_repository",
        arguments: { query: "upstream-org/backend" },
      },
      {
        family: "context",
        name: "context_read",
        arguments: { source_ref: "code:upstream-org/backend@abc123:src/index.ts#L10" },
      },
      {
        family: "resource",
        name: "resource_catalog_search",
        arguments: { provider: "github" },
      },
    ];

    for (const operation of operations) {
      const response = await routes.request("/", {
        method: "POST",
        headers: {
          authorization: `Bearer ${mintToolToken(liveClaims, 60_000)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(operation),
      });
      expect(response.status).toBe(200);
    }
    expect(calls).toEqual(operations.map(({ family, name, arguments: args }) => ({
      family,
      name,
      args,
    })));
  });

  test("fails closed when the capability no longer resolves to one live run", async () => {
    process.env.TOOL_GATEWAY_SECRET = "github-route-test-secret-0123456789";
    const token = mintToolToken(
      {
        orgId: "org-a",
        userId: "user-a",
        threadId: "thread-a",
        runId: "run-a",
        scope: "run",
      },
      60_000,
    );
    let executed = false;
    const response = await createInternalGithubRoutes({
      resolveIdentity: async () => null,
      executeLocal: async () => {
        executed = true;
        return { content: [{ type: "text", text: "unexpected" }] };
      },
    }).request("/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        family: "github",
        name: "github_list_prs",
        arguments: { repo: "upstream-org/backend" },
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "inactive_capability" });
    expect(executed).toBe(false);
  });
});
