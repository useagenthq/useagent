import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { githubOrgAccessErrorForOrg, listBranches, listRepos, listRepoTree } from "./repos";

// GET /api/repos — the real repository list powering the New Task composer's
// repo picker. Org-scoped (auth required, like the other domain routes); the
// backend-held GitHub token stays server-side and never appears in the response.
export const reposRoutes = new Hono<AppEnv>();

reposRoutes.use("*", orgScope);

reposRoutes.get("/", async (c) => {
  const orgId = c.get("orgId");
  const accessError = await githubOrgAccessErrorForOrg(orgId);
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
  return c.json(
    await listBranches(`${c.req.param("owner")}/${c.req.param("name")}`, orgId),
  );
});

// GET /api/repos/:owner/:name/tree?ref=<branch>&path=<dir> — ONE directory level
// for the composer's @-mention file picker. Same server-side auth; scoped to the
// offered repos and bounded (capped entries, truncation reported). `path` omitted
// = repo root; `ref` omitted = the repo's default branch.
reposRoutes.get("/:owner/:name/tree", async (c) => {
  const orgId = c.get("orgId");
  return c.json(
    await listRepoTree(`${c.req.param("owner")}/${c.req.param("name")}`, orgId, {
      ref: c.req.query("ref") ?? null,
      path: c.req.query("path") ?? null,
    }),
  );
});
