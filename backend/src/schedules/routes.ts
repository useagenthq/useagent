import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import {
  getScheduleForOrg,
  listFirings,
  listSchedules,
} from "./repo";
import {
  createScheduleForOrg,
  deleteScheduleForOrg,
  previewNextRuns,
  runScheduleNow,
  ScheduleServiceError,
  updateScheduleForOrg,
} from "./service";
import { runCreateBodyLimit } from "../runs/run-create-policy";

export const schedulesRoutes = new Hono<AppEnv>();

schedulesRoutes.use("*", orgScope);

// List all automations for the active org (newest first). The `schedules`
// envelope is retained for backward-compatible clients and resumed sessions.
schedulesRoutes.get("/", async (c) => {
  const automations = await listSchedules(c.get("orgId"));
  return c.json({ automations, schedules: automations });
});

// The next runs a cron and zone would have, before anything is saved: an
// editor's live preview, from the engine the scheduler fires by.
schedulesRoutes.get("/preview", (c) => {
  try {
    return c.json({ next_runs: previewNextRuns({ cron: c.req.query("cron"), timezone: c.req.query("timezone") }) });
  } catch (error) {
    if (error instanceof ScheduleServiceError) return c.json(error.body, error.status);
    throw error;
  }
});

// Create a schedule. `enabled` is always FALSE on create (KiroCrew's safety
// default) so a new schedule never auto-fires until explicitly enabled.
schedulesRoutes.post("/", runCreateBodyLimit, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  try {
    const schedule = await createScheduleForOrg(
      { orgId: c.get("orgId"), userId: c.get("userId") },
      body,
    );
    return c.json(schedule, 201);
  } catch (error) {
    if (error instanceof ScheduleServiceError) return c.json(error.body, error.status);
    throw error;
  }
});

// Update a schedule (partial) — enable/disable or edit its fields.
schedulesRoutes.patch("/:id", runCreateBodyLimit, async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  try {
    return c.json(await updateScheduleForOrg(c.get("orgId"), id, body, c.get("userId") ?? null));
  } catch (error) {
    if (error instanceof ScheduleServiceError) return c.json(error.body, error.status);
    throw error;
  }
});

// Manual fire: create a real run now and record a `manual` firing.
schedulesRoutes.post("/:id/run-now", async (c) => {
  const schedule = await getScheduleForOrg(c.get("orgId"), c.req.param("id"));
  if (!schedule) return c.json({ error: "schedule not found" }, 404);
  try {
    const runId = await runScheduleNow(schedule, c.get("userId") ?? null);
    return c.json({ run_id: runId }, 201);
  } catch (error) {
    if (error instanceof ScheduleServiceError) return c.json(error.body, error.status);
    throw error;
  }
});

// Firing history for a schedule (org-scoped), newest first.
schedulesRoutes.get("/:id/history", async (c) => {
  const schedule = await getScheduleForOrg(c.get("orgId"), c.req.param("id"));
  if (!schedule) return c.json({ error: "schedule not found" }, 404);
  return c.json({ firings: await listFirings(schedule.id) });
});

// Delete a schedule and its firing projection rows. Runs created by old firings
// remain in the durable run log.
schedulesRoutes.delete("/:id", async (c) => {
  try {
    await deleteScheduleForOrg(c.get("orgId"), c.req.param("id"), c.get("userId") ?? null);
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof ScheduleServiceError) return c.json(error.body, error.status);
    throw error;
  }
});
