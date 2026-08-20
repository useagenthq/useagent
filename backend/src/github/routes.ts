import { Hono } from "hono";
import { githubConfigured } from "../env";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import {
  githubOrgAccessError,
  listBranches,
  listRepos,
} from "./repos";

// GET /api/repos — the real repository list powering the New Task composer's
// repo picker. Org-scoped (auth required, like the other domain routes); the
// backend-held GitHub token stays server-side and never appears in the response.
export const reposRoutes = new Hono<AppEnv>();

reposRoutes.use("*", orgScope);

reposRoutes.get("/", async (c) => {
  const orgId = c.get("orgId");
  const accessError = githubConfigured() ? githubOrgAccessError(orgId) : null;
  if (accessError) {
    return c.json({ configured: true, repos: [], error: accessError }, 403);
  }
  return c.json(await listRepos(orgId));
});

// GET /api/repos/:owner/:name/branches — real branches for the composer's
// per-repo branch picker. Same server-side auth; scoped to the offered repos
// (an unknown repo returns an honest error, not arbitrary-repo proxying).
reposRoutes.get("/:owner/:name/branches", async (c) => {
  const orgId = c.get("orgId");
  const accessError = githubConfigured() ? githubOrgAccessError(orgId) : null;
  if (accessError) {
    return c.json({ configured: true, branches: [], error: accessError }, 403);
  }
  return c.json(
    await listBranches(`${c.req.param("owner")}/${c.req.param("name")}`, orgId),
  );
});
