import { afterEach, describe, expect, test } from "bun:test";
import type { RunResource } from "../../resources/types";
import {
  createResourceToolService,
  executeResourceTool,
  projectRunResourceBindings,
  RESOURCE_TOOLS,
  setResourceToolServiceForTest,
} from "./resource-tools";
import { getRunForOrg } from "../../runs/repo";
import type { ToolTokenClaims } from "./token";

const CLAIMS = {
  orgId: "org-a",
  userId: "user-a",
  threadId: "thread-a",
  runId: "run-a",
  scope: "run",
  exp: Date.now() + 60_000,
} as const satisfies ToolTokenClaims;

const repository: RunResource = {
  kind: "code.repository",
  provider: "github",
  locator: { type: "github.repository", repository: "acme/api", revision: "main" },
  capabilities: ["content.read", "code.checkout"],
  provenance: [{
    source: "explicit",
    channel: "web",
    raw: "github:repository:acme/api",
    start: null,
    end: null,
  }],
};

afterEach(() => setResourceToolServiceForTest(null));

describe("provider-neutral resource gateway tools", () => {
  test("advertises inventory and binding contracts without identity or credential inputs", () => {
    expect(RESOURCE_TOOLS.map((tool) => tool.name)).toEqual([
      "resource_catalog_search",
      "run_resource_bindings",
    ]);
    for (const tool of RESOURCE_TOOLS) {
      const properties = Object.keys(
        (tool.inputSchema.properties ?? {}) as Record<string, unknown>,
      );
      expect(properties).not.toContain("orgId");
      expect(properties).not.toContain("userId");
      expect(properties).not.toContain("runId");
      expect(properties).not.toContain("token");
      expect(properties).not.toContain("connectionId");
    }
  });

  test("resource_catalog_search description is the authoritative answer to org repository access, above the sandbox filesystem", () => {
    const tool = RESOURCE_TOOLS.find((t) => t.name === "resource_catalog_search");
    expect(tool).toBeDefined();
    const description = tool!.description;
    // The truthfulness fix: the agent must learn that repository/resource access
    // is answered here, not by inspecting an (often empty) sandbox filesystem.
    expect(description).toContain("this organization can access");
    expect(description).toContain("authoritative");
    expect(description).toContain("sandbox filesystem is not");
  });

  test("catalog search derives actor scope from signed claims and returns safe inventory metadata", async () => {
    const calls: unknown[] = [];
    setResourceToolServiceForTest({
      async search(scope, provider, input) {
        calls.push({ scope, provider, input });
        return {
          items: [{
            catalogRef: "rc_safe",
            provider: "github",
            kind: "code.repository",
            name: "acme/api",
            locator: { type: "github.repository", repository: "acme/api" },
            metadata: { private: true, defaultBranch: "main" },
          }],
          nextCursor: null,
        };
      },
      async bindings() {
        return [];
      },
    });

    const response = await executeResourceTool(CLAIMS, "resource_catalog_search", {
      provider: "github",
      query: "api",
      limit: 10,
    });

    expect(calls).toEqual([{
      scope: { orgId: "org-a", userId: "user-a" },
      provider: "github",
      input: { query: "api", cursor: null, limit: 10 },
    }]);
    expect(response.structuredContent?.items).toEqual([
      expect.objectContaining({ catalogRef: "rc_safe", name: "acme/api" }),
    ]);
    expect(JSON.stringify(response)).not.toContain("connectionId");
    expect(JSON.stringify(response)).not.toContain("runtimeBindingId");
  });

  test("catalog search fails closed without an authenticated actor", async () => {
    const response = await executeResourceTool(
      { ...CLAIMS, userId: "" },
      "resource_catalog_search",
      { provider: "github" },
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("authenticated user identity");
  });

  test("run bindings stay separate from connected inventory", async () => {
    setResourceToolServiceForTest({
      async search() {
        return { items: [], nextCursor: null };
      },
      async bindings(claims) {
        expect(claims).toBe(CLAIMS);
        return [];
      },
    });

    const response = await executeResourceTool(CLAIMS, "run_resource_bindings", {});
    expect(response.structuredContent?.bindings).toEqual([]);
    expect(response.content[0]?.text).toContain("Connected inventory may still be available");
  });

  test("projects persisted resources and legacy repositories into stable run bindings", () => {
    const projected = projectRunResourceBindings({
      runId: "run-a",
      resources: [repository],
      repos: ["acme/api:main", "acme/web:develop"],
    });
    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({
      bindingId: expect.stringMatching(/^rb_/),
      provider: "github",
      kind: "code.repository",
      locator: { repository: "acme/api", revision: "main" },
    });
    expect(projected[1]).toMatchObject({
      bindingId: expect.stringMatching(/^rb_/),
      locator: { repository: "acme/web", revision: "develop" },
      capabilities: ["content.read", "code.checkout"],
    });
  });

  test("production binding service enforces organization and thread scope", async () => {
    const run = {
      id: "run-a",
      threadId: "thread-a",
      resolvedResources: [repository],
      repos: ["acme/api:main"],
    } as unknown as Awaited<ReturnType<typeof getRunForOrg>>;
    const calls: Array<{ orgId: string; runId: string }> = [];
    const service = createResourceToolService({
      async search() {
        return { items: [], nextCursor: null };
      },
      async getRun(orgId, runId) {
        calls.push({ orgId, runId });
        return orgId === "org-a" && runId === "run-a" ? run : null;
      },
    });

    const bindings = await service.bindings(CLAIMS);
    expect(calls).toEqual([{ orgId: "org-a", runId: "run-a" }]);
    expect(bindings).toHaveLength(1);

    await expect(
      service.bindings({ ...CLAIMS, orgId: "org-b" }),
    ).rejects.toThrow("run not found in this thread");
    await expect(
      service.bindings({ ...CLAIMS, threadId: "thread-b" }),
    ).rejects.toThrow("run not found in this thread");
  });
});
