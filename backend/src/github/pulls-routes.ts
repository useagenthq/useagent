import { Hono } from "hono";
import { githubConfigured } from "../env";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { githubOrgAccessError } from "./repos";
import { listPulls } from "./pulls";

// GET /api/pulls — real open pull requests across the org's accessible repos,
// powering the /review page. Org-scoped (auth required, like the other domain
// routes); the backend-held GitHub token stays server-side.
export const pullsRoutes = new Hono<AppEnv>();

pullsRoutes.use("*", orgScope);

pullsRoutes.get("/", async (c) => {
  const orgId = c.get("orgId");
  const accessError = githubConfigured() ? githubOrgAccessError(orgId) : null;
  if (accessError) {
    return c.json({ configured: true, pulls: [], error: accessError }, 403);
  }
  return c.json(await listPulls(orgId));
});
