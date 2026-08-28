import type { Hono } from "hono";
import type { AppEnv } from "../http.js";
import { listUploadsForRuns } from "../uploads/repo.js";
import {
  getCustomerRunForOrg,
  getCustomerRunWithSteps,
  getThreadForRun,
  getThreadOutlineForRun,
  getThreadRunsByIds,
  listRunSummaries,
  listRunsWithSteps,
} from "./repo.js";
import { getRunTimingTable } from "./run-timing.js";

/** Bound on ids per windowed turns fetch: keeps one island's payload and query
 * plan small. The frontend chunks larger windows into multiple requests. */
const MAX_TURN_FETCH_IDS = 30;

export function registerRunReadRoutes(routes: Hono<AppEnv>): void {
  // List runs (newest first) with their steps, scoped to the active org. By
  // default only thread roots (one entry per conversation); `?all=1` returns every
  // run in every thread.
  routes.get("/", async (c) => {
    const all = c.req.query("all") === "1";
    const requestedLimit = Number.parseInt(c.req.query("limit") ?? "100", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(c.req.query("view") === "summary" ? 1_000 : 100, Math.max(1, requestedLimit))
      : 100;
    if (c.req.query("view") === "summary") {
      return c.json({
        runs: await listRunSummaries(c.get("orgId"), {
          all,
          limit,
          includeActive: c.req.query("include_active") === "1",
        }),
      });
    }
    return c.json({ runs: await listRunsWithSteps(c.get("orgId"), { all, limit }) });
  });

  // Single run + steps (scoped to the active org - cross-org id -> 404).
  // `?thread=1` returns the whole thread the run belongs to, oldest->newest.
  routes.get("/:id", async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (c.req.query("thread") === "1") {
      const thread = await getThreadForRun(orgId, id);
      if (!thread) return c.json({ error: "run not found" }, 404);
      return c.json({ thread });
    }
    const run = await getCustomerRunWithSteps(orgId, id);
    if (!run) return c.json({ error: "run not found" }, 404);
    return c.json(run);
  });

  // Thread OUTLINE (windowed initial loading): the per-turn skeleton of the whole
  // thread `:id` belongs to, oldest->newest. No step bodies or JSON payloads.
  routes.get("/:id/thread-outline", async (c) => {
    const turns = await getThreadOutlineForRun(c.get("orgId"), c.req.param("id"));
    if (!turns) return c.json({ error: "run not found" }, 404);
    return c.json({ turns });
  });

  // WINDOWED turns fetch: requested runs of `:id`'s thread with full steps.
  // Ids outside the thread or org are silently dropped, never leaked.
  routes.get("/:id/turns", async (c) => {
    const raw = c.req.query("ids") ?? "";
    const ids = [
      ...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean)),
    ];
    if (ids.length === 0) return c.json({ error: "ids is required" }, 400);
    if (ids.length > MAX_TURN_FETCH_IDS) {
      return c.json({ error: `ids must contain at most ${MAX_TURN_FETCH_IDS} run ids` }, 400);
    }
    const turns = await getThreadRunsByIds(c.get("orgId"), c.req.param("id"), ids);
    if (!turns) return c.json({ error: "run not found" }, 404);
    return c.json({ turns });
  });

  // A run's inbound attachments. The compact list also rides the run/thread
  // payload; this route remains for callers that want it standalone.
  routes.get("/:id/uploads", async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!(await getCustomerRunForOrg(orgId, id))) return c.json({ error: "run not found" }, 404);
    const uploads = (await listUploadsForRuns([id])).get(id) ?? [];
    return c.json({ uploads });
  });

  // Per-run developer timing table. Diagnostics only: numbers and stage names.
  routes.get("/:id/timings", async (c) => {
    const orgId = c.get("orgId");
    const id = c.req.param("id");
    if (!(await getCustomerRunForOrg(orgId, id))) return c.json({ error: "run not found" }, 404);
    return c.json(await getRunTimingTable(id));
  });
}
