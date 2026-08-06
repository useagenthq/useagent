import { Hono } from "hono";
import type { AppEnv } from "../http";
import { ENGINE_IDS, type EngineId } from "../db/schema";
import { orgScope } from "../middleware/org";
import { isValidCron, isValidTimezone } from "./cron";
import { fireSchedule } from "./fire";
import {
  createSchedule,
  getScheduleForOrg,
  listFirings,
  listSchedules,
  updateSchedule,
} from "./repo";

export const schedulesRoutes = new Hono<AppEnv>();

schedulesRoutes.use("*", orgScope);

// A schedule can run under any real engine (same set the runs route accepts).
const ENGINES: readonly EngineId[] = ENGINE_IDS;
const DEFAULT_MODEL = "claude-opus-5";

// List all schedules for the active org (newest first).
schedulesRoutes.get("/", async (c) =>
  c.json({ schedules: await listSchedules(c.get("orgId")) }),
);

// Create a schedule. `enabled` is always FALSE on create (reference bot's safety
// default) so a new schedule never auto-fires until explicitly enabled.
schedulesRoutes.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);

  const cron = typeof body.cron === "string" ? body.cron.trim() : "";
  if (!cron) return c.json({ error: "cron is required" }, 400);
  if (!isValidCron(cron)) {
    return c.json({ error: "cron must be a valid 5-field expression" }, 400);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return c.json({ error: "prompt is required" }, 400);

  // Optional IANA timezone. Absent/empty → null (server local). A malformed zone
  // is a client error, never silently dropped (it would misfire every occurrence).
  let timezone: string | null = null;
  if (body.timezone !== undefined && body.timezone !== null && body.timezone !== "") {
    const tz = typeof body.timezone === "string" ? body.timezone.trim() : "";
    if (!isValidTimezone(tz)) {
      return c.json({ error: "timezone must be a valid IANA name" }, 400);
    }
    timezone = tz;
  }

  let engine: EngineId = "mock";
  if (body.engine !== undefined) {
    if (
      typeof body.engine !== "string" ||
      !ENGINES.includes(body.engine as EngineId)
    ) {
      return c.json({ error: `engine must be one of: ${ENGINES.join(", ")}` }, 400);
    }
    engine = body.engine as EngineId;
  }

  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : DEFAULT_MODEL;

  const schedule = await createSchedule({
    orgId: c.get("orgId"),
    userId: c.get("userId"),
    name,
    cron,
    timezone,
    prompt,
    engine,
    model,
  });
  return c.json(schedule, 201);
});

// Update a schedule (partial) — enable/disable or edit its fields.
schedulesRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const patch: Partial<{
    name: string;
    cron: string;
    timezone: string | null;
    prompt: string;
    engine: EngineId;
    model: string;
    enabled: boolean;
  }> = {};

  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  // timezone: an explicit "" or null clears it (→ server local); a non-empty
  // string must be a valid IANA name.
  if (body.timezone !== undefined) {
    if (body.timezone === null || body.timezone === "") {
      patch.timezone = null;
    } else {
      const tz = typeof body.timezone === "string" ? body.timezone.trim() : "";
      if (!isValidTimezone(tz)) {
        return c.json({ error: "timezone must be a valid IANA name" }, 400);
      }
      patch.timezone = tz;
    }
  }
  if (typeof body.name === "string" && body.name.trim())
    patch.name = body.name.trim();
  if (typeof body.prompt === "string" && body.prompt.trim())
    patch.prompt = body.prompt.trim();
  if (typeof body.model === "string" && body.model.trim())
    patch.model = body.model.trim();
  if (typeof body.cron === "string") {
    const cron = body.cron.trim();
    if (!isValidCron(cron)) {
      return c.json({ error: "cron must be a valid 5-field expression" }, 400);
    }
    patch.cron = cron;
  }
  if (body.engine !== undefined) {
    if (
      typeof body.engine !== "string" ||
      !ENGINES.includes(body.engine as EngineId)
    ) {
      return c.json({ error: `engine must be one of: ${ENGINES.join(", ")}` }, 400);
    }
    patch.engine = body.engine as EngineId;
  }

  const updated = await updateSchedule(c.get("orgId"), id, patch);
  if (!updated) return c.json({ error: "schedule not found" }, 404);
  return c.json(updated);
});

// Manual fire: create a real run now and record a `manual` firing.
schedulesRoutes.post("/:id/run-now", async (c) => {
  const schedule = await getScheduleForOrg(c.get("orgId"), c.req.param("id"));
  if (!schedule) return c.json({ error: "schedule not found" }, 404);
  const runId = await fireSchedule(schedule, "manual");
  return c.json({ run_id: runId }, 201);
});

// Firing history for a schedule (org-scoped), newest first.
schedulesRoutes.get("/:id/history", async (c) => {
  const schedule = await getScheduleForOrg(c.get("orgId"), c.req.param("id"));
  if (!schedule) return c.json({ error: "schedule not found" }, 404);
  return c.json({ firings: await listFirings(schedule.id) });
});
