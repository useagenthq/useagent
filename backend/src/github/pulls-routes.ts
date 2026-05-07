import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { listPulls } from "./pulls";

// GET /api/pulls — real open pull requests across the org's accessible repos,
// powering the /review page. Org-scoped (auth required, like the other domain
// routes); the backend-held GitHub token stays server-side.
export const pullsRoutes = new Hono<AppEnv>();

pullsRoutes.use("*", orgScope);

pullsRoutes.get("/", async (c) => c.json(await listPulls()));
