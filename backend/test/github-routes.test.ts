import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../src/http";
import { pullsRoutes } from "../src/github/pulls-routes";
import { clearRepoCache } from "../src/github/repos";
import { reposRoutes } from "../src/github/routes";

const originalToken = process.env.GITHUB_TOKEN;
const originalTenant = process.env.GITHUB_TENANT_ORG_ID;

afterEach(() => {
  if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalToken;
  if (originalTenant === undefined) delete process.env.GITHUB_TENANT_ORG_ID;
  else process.env.GITHUB_TENANT_ORG_ID = originalTenant;
  clearRepoCache();
});

describe("github routes — product organization scope", () => {
  test("returns 403 for an org that does not own the shared GitHub connection", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_TENANT_ORG_ID = "org-primary";

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("orgId", "org-other");
      c.set("userId", "user-other");
      return next();
    });
    app.route("/", reposRoutes);

    const response = await app.request("/");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      configured: true,
      repos: [],
      error: "GitHub repository access is not available to this organization",
    });
  });

  test("rejects pull listing for an org that does not own the shared connection", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_TENANT_ORG_ID = "org-primary";

    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("orgId", "org-other");
      c.set("userId", "user-other");
      return next();
    });
    app.route("/", pullsRoutes);

    const response = await app.request("/");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      configured: true,
      pulls: [],
      error: "GitHub repository access is not available to this organization",
    });
  });
});
