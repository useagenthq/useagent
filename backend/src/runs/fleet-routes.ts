import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { getMachineStats, getModelBurn } from "./fleet";
import { orgCapacityView } from "../fleet/view";

// GET /api/fleet — real numbers for the /agent/workspace "Limits" card:
// per-model token/cost/run burn for today + the org's live Daytona footprint.
// Org-scoped like the other domain routes; the Daytona key stays server-side and
// never appears in the response.
export const fleetRoutes = new Hono<AppEnv>();

fleetRoutes.use("*", orgScope);

fleetRoutes.get("/", async (c) => {
  const orgId = c.get("orgId");
  const [burn, machine] = await Promise.all([getModelBurn(orgId), getMachineStats(orgId)]);
  return c.json({ ...burn, machine });
});

// GET /api/fleet/capacity — durable queue + capacity visibility (HA Stage A):
// this org's active sandboxes vs limit, queued backlog vs the durable ceiling,
// and global capacity health. Powers the queued-run/usage UI + operators.
fleetRoutes.get("/capacity", async (c) => {
  const orgId = c.get("orgId");
  return c.json(await orgCapacityView(orgId));
});
