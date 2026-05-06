import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { listRepos } from "./repos";

// GET /api/repos — the real repository list powering the New Task composer's
// repo picker. Org-scoped (auth required, like the other domain routes); the
// backend-held GitHub token stays server-side and never appears in the response.
export const reposRoutes = new Hono<AppEnv>();

reposRoutes.use("*", orgScope);

reposRoutes.get("/", async (c) => c.json(await listRepos()));
