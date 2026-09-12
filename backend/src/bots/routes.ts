import { Hono } from "hono";
import { acceptRunCancel } from "../commands/cancel";
import { isUniqueViolation } from "../db/pg-errors";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { engineResolutionErrorBody, resolveAcceptedEngine } from "../runs/engine-readiness";
import { isModelAllowedForEngine } from "../runs/model-policy";
import { handleRunCreate } from "../runs/routes";
import { type RunCreateBody, runCreateBodyLimit } from "../runs/run-create-policy";
import { resolveSkillSelection } from "../skills/repo";
import {
  type BotInput,
  changedPresetFields,
  createBotRow,
  describeBot,
  describeBots,
  findBotByName,
  getBotRoutine,
  getBotRow,
  latestRunInThread,
  listBotRoutines,
  listBotRows,
  parseBotInput,
  rowToInput,
  attachRoutine,
  setBotHomeThread,
  updateBotRow,
} from "./repo";
import { botsEnabled } from "./rollout";
import { listFirings, markFired } from "../schedules/repo";
import {
  createScheduleForOrg,
  deleteScheduleForOrg,
  fireScheduleForOrg,
  ScheduleServiceError,
  updateScheduleForOrg,
} from "../schedules/service";

const MESSAGE_MAX = 20_000;
// Every gateway-capable turn lists the org's bots for its prompt and the roster
// fans out per bot, so a workspace has a ceiling instead of growing without end.
const MAX_BOTS_PER_ORG = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres rejects a malformed uuid with a 500-shaped error; make it a plain 404. */
function botId(raw: string): string | null {
  return UUID.test(raw) ? raw.toLowerCase() : null;
}

/**
 * /api/bots - a bot is a preset over a durable home thread. Messages go
 * through the same run-create door as every other turn (`handleRunCreate`),
 * so bots inherit idempotency, resource intake, skill pinning, fleet limits,
 * and the thread stream for free. This module adds the preset, validates it
 * against live config at create time (so a bad preset fails loudly here, not
 * at the first message), and writes the standing-rules root turn once.
 */
export const botsRoutes = new Hono<AppEnv>();
botsRoutes.use("*", orgScope);
botsRoutes.use("*", runCreateBodyLimit);
botsRoutes.use("*", async (c, next) => {
  if (!botsEnabled(c.get("orgId"))) return c.json({ error: "bots_disabled" }, 404);
  await next();
});

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const value = await c.req.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type PresetProblem = { readonly status: 400 | 403 | 404; readonly body: Record<string, unknown> };

/** Names are unique per org ignoring case; the message names the bot that holds it. */
function nameTaken(name: string) {
  return { error: "invalid_bot", field: "name", reason: `A bot named ${name} already exists. Choose another name.` };
}

/** Live-config checks a structurally valid preset still has to pass. */
async function checkPreset(orgId: string, input: BotInput): Promise<PresetProblem | null> {
  const engine = resolveAcceptedEngine(input.engine);
  if (!engine.ok) return { status: engine.status, body: { ...engineResolutionErrorBody(engine), field: "engine" } };
  if (input.model && !isModelAllowedForEngine(input.engine, input.model)) {
    return { status: 400, body: { error: "model_not_allowed", field: "model", reason: `${input.model} is not offered for ${input.engine}` } };
  }
  const skillId = input.skillIds[0];
  if (skillId) {
    const pinned = await resolveSkillSelection(orgId, { id: skillId });
    if (!pinned) return { status: 404, body: { error: "skill_not_found", field: "skillIds", reason: `skill ${skillId} not found` } };
  }
  return null;
}

botsRoutes.get("/", async (c) => {
  const rows = await listBotRows(c.get("orgId"));
  return c.json({ bots: await describeBots(c.get("orgId"), rows) });
});

botsRoutes.post("/", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  const parsed = parseBotInput(body, null);
  if ("error" in parsed) return c.json({ error: "invalid_bot", ...parsed.error }, 400);
  if ((await listBotRows(c.get("orgId"))).length >= MAX_BOTS_PER_ORG) {
    return c.json(
      { error: "bot_limit", limit: MAX_BOTS_PER_ORG, reason: `This workspace already has ${MAX_BOTS_PER_ORG} bots. Archive one before creating another.` },
      409,
    );
  }
  const problem = await checkPreset(c.get("orgId"), parsed.input);
  if (problem) return c.json(problem.body, problem.status);
  const holder = await findBotByName(c.get("orgId"), parsed.input.name);
  if (holder) return c.json(nameTaken(holder.name), 409);
  try {
    const row = await createBotRow(c.get("orgId"), parsed.input, c.get("userId"));
    return c.json({ bot: await describeBot(c.get("orgId"), row) }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) return c.json(nameTaken(parsed.input.name), 409);
    throw error;
  }
});

botsRoutes.get("/:id", async (c) => {
  const id = botId(c.req.param("id"));
  if (!id) return c.json({ error: "not_found" }, 404);
  const row = await getBotRow(c.get("orgId"), id);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ bot: await describeBot(c.get("orgId"), row) });
});

botsRoutes.patch("/:id", async (c) => {
  const id = botId(c.req.param("id"));
  if (!id) return c.json({ error: "not_found" }, 404);
  const row = await getBotRow(c.get("orgId"), id);
  if (!row) return c.json({ error: "not_found" }, 404);
  const body = await readBody(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  const base = rowToInput(row);
  const parsed = parseBotInput(body, base);
  if ("error" in parsed) return c.json({ error: "invalid_bot", ...parsed.error }, 400);
  // Archiving is a lifecycle flag, not part of the preset: the bot leaves the
  // roster and @mentions while its threads stay readable.
  const archived = body.archived;
  if (archived !== undefined && typeof archived !== "boolean") {
    return c.json({ error: "invalid_bot", field: "archived", reason: "archived must be true or false" }, 400);
  }
  // The home thread already runs on the stored preset; a changed engine would
  // 400 every follow-up and changed skills/repos/scope would silently not apply.
  const changed = changedPresetFields(base, parsed.input);
  if (row.homeThreadId && changed.length > 0) {
    return c.json(
      { error: "preset_locked", fields: changed, reason: "engine, model, skills, repos and memory scope are fixed once the bot has a home thread" },
      409,
    );
  }
  // Identity edits (name, title, rules, avatar) never touch live engine config:
  // a provider health dip must not block saving the standing rules.
  if (changed.length > 0) {
    const problem = await checkPreset(c.get("orgId"), parsed.input);
    if (problem) return c.json(problem.body, problem.status);
  }
  if (parsed.input.name !== base.name) {
    const holder = await findBotByName(c.get("orgId"), parsed.input.name, row.id);
    if (holder) return c.json(nameTaken(holder.name), 409);
  }
  try {
    const updated = await updateBotRow(c.get("orgId"), row.id, parsed.input, archived);
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json({ bot: await describeBot(c.get("orgId"), updated) });
  } catch (error) {
    if (isUniqueViolation(error)) return c.json(nameTaken(parsed.input.name), 409);
    throw error;
  }
});

/**
 * Message the bot. First message: a root run with the preset, which becomes
 * the home thread. Later messages: plain follow-ups chained under the thread
 * head (engine, model, skills, repos and scope are inherited from the thread,
 * never re-sent). The stored prompt is only what the person typed; identity
 * and standing rules reach the model as turn context (see prompt-context.ts).
 * Returns the run-create response unchanged (201 accepted, 200 idempotent
 * replay, 4xx).
 */
botsRoutes.post("/:id/messages", async (c) => {
  const orgId = c.get("orgId");
  const id = botId(c.req.param("id"));
  if (!id) return c.json({ error: "not_found" }, 404);
  const row = await getBotRow(orgId, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  const body = await readBody(c);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text_required" }, 400);
  if (text.length > MESSAGE_MAX) return c.json({ error: "text_too_long", max: MESSAGE_MAX }, 400);

  const head = row.homeThreadId ? await latestRunInThread(orgId, row.homeThreadId) : null;
  if (head) {
    return handleRunCreate(c, { body: { prompt: text, parent_run_id: head.id } });
  }

  const skillId = row.skillIds[0];
  const runBody: RunCreateBody = {
    prompt: text,
    engine: row.engine,
    memory_scope: row.memoryScope,
    ...(row.model ? { model: row.model } : {}),
    ...(row.repos.length > 0 ? { repos: [...row.repos] } : {}),
    ...(skillId ? { skill: { id: skillId } } : {}),
  };
  const response = await handleRunCreate(c, { body: runBody });
  // 201 = accepted now; 200 = an idempotent replay of the same first message.
  if (response.status !== 201 && response.status !== 200) return response;
  const accepted = (await response.clone().json()) as { id?: unknown };
  if (typeof accepted.id !== "string") return response;
  if (await setBotHomeThread(orgId, row.id, accepted.id)) return response;

  // Lost a race with a concurrent first message: the other root is the home
  // thread. Cancel this stray root rather than leave it running unattached.
  const current = await getBotRow(orgId, row.id);
  if (current?.homeThreadId !== accepted.id) {
    try {
      await acceptRunCancel({ orgId, actorId: c.get("userId"), runId: accepted.id });
    } catch (error) {
      console.error(`[bots] could not cancel stray root ${accepted.id} for bot ${row.id}:`, error);
    }
    return c.json(
      {
        error: "home_thread_already_created",
        homeThreadId: current?.homeThreadId ?? null,
        reason: "Another message opened this bot's thread first. Send yours again into that thread.",
      },
      409,
    );
  }
  return response;
});

/* ------------------------------------------------------------------------ */
/* Routines: schedules owned by the bot. They reuse the automations service  */
/* (validation, cron, skill pinning, firing) and differ only in where they   */
/* post - the bot's home thread - and in inheriting the bot's preset.        */
/* ------------------------------------------------------------------------ */

const ROUTINE_PATCH_FIELDS = ["name", "cron", "timezone", "prompt", "enabled"] as const;

function routineView(row: {
  id: string;
  name: string;
  cron: string;
  timezone: string | null;
  prompt: string;
  enabled: boolean;
  lastFiredAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    enabled: row.enabled,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function scheduleError(error: unknown): Response | null {
  return error instanceof ScheduleServiceError ? Response.json(error.body, { status: error.status }) : null;
}

botsRoutes.get("/:id/routines", async (c) => {
  const id = botId(c.req.param("id"));
  if (!id) return c.json({ error: "not_found" }, 404);
  const row = await getBotRow(c.get("orgId"), id);
  if (!row) return c.json({ error: "not_found" }, 404);
  const routines = await listBotRoutines(c.get("orgId"), row.id);
  return c.json({ routines: routines.map(routineView) });
});

botsRoutes.post("/:id/routines", async (c) => {
  const orgId = c.get("orgId");
  const id = botId(c.req.param("id"));
  if (!id) return c.json({ error: "not_found" }, 404);
  const row = await getBotRow(orgId, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  const body = await readBody(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  const skillId = row.skillIds[0];
  // The routine carries the bot's preset; the body may only shape when/what.
  const draft: Record<string, unknown> = {
    name: body.name,
    cron: body.cron,
    timezone: body.timezone,
    prompt: body.prompt,
    enabled: body.enabled ?? true,
    engine: row.engine,
    ...(row.model ? { model: row.model } : {}),
    ...(row.repos.length > 0 ? { repos: [...row.repos] } : {}),
    ...(skillId ? { skill: { id: skillId } } : {}),
  };
  try {
    const created = await createScheduleForOrg({ orgId, userId: c.get("userId") }, draft);
    await attachRoutine(orgId, created.id, row.id);
    // Automations are created paused; a routine is on unless asked otherwise.
    if (body.enabled !== false) await updateScheduleForOrg(orgId, created.id, { enabled: true });
    const routine = await getBotRoutine(orgId, row.id, created.id);
    if (!routine) return c.json({ error: "routine_not_attached" }, 500);
    return c.json({ routine: routineView(routine) }, 201);
  } catch (error) {
    return scheduleError(error) ?? Promise.reject(error);
  }
});

botsRoutes.patch("/:id/routines/:routineId", async (c) => {
  const orgId = c.get("orgId");
  const id = botId(c.req.param("id"));
  const routineId = botId(c.req.param("routineId"));
  if (!id || !routineId) return c.json({ error: "not_found" }, 404);
  const routine = await getBotRoutine(orgId, id, routineId);
  if (!routine) return c.json({ error: "not_found" }, 404);
  const body = await readBody(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  const patch: Record<string, unknown> = {};
  for (const field of ROUTINE_PATCH_FIELDS) if (body[field] !== undefined) patch[field] = body[field];
  try {
    await updateScheduleForOrg(orgId, routine.id, patch);
    const updated = await getBotRoutine(orgId, id, routineId);
    return c.json({ routine: updated ? routineView(updated) : null });
  } catch (error) {
    return scheduleError(error) ?? Promise.reject(error);
  }
});

botsRoutes.delete("/:id/routines/:routineId", async (c) => {
  const orgId = c.get("orgId");
  const id = botId(c.req.param("id"));
  const routineId = botId(c.req.param("routineId"));
  if (!id || !routineId) return c.json({ error: "not_found" }, 404);
  const routine = await getBotRoutine(orgId, id, routineId);
  if (!routine) return c.json({ error: "not_found" }, 404);
  try {
    await deleteScheduleForOrg(orgId, routine.id);
    return c.body(null, 204);
  } catch (error) {
    return scheduleError(error) ?? Promise.reject(error);
  }
});

/** Test run: fire the routine now. Posts into the home thread like a cron firing;
 *  the response carries the routine as fired (its `lastFiredAt` just moved). */
botsRoutes.post("/:id/routines/:routineId/run-now", async (c) => {
  const orgId = c.get("orgId");
  const id = botId(c.req.param("id"));
  const routineId = botId(c.req.param("routineId"));
  if (!id || !routineId) return c.json({ error: "not_found" }, 404);
  const routine = await getBotRoutine(orgId, id, routineId);
  if (!routine) return c.json({ error: "not_found" }, 404);
  try {
    const runId = await fireScheduleForOrg(routine, "manual");
    // A test run is a firing too: the row's "last run" must show it, not wait for cron.
    await markFired(routine.id, new Date());
    const fired = (await getBotRoutine(orgId, id, routineId)) ?? routine;
    return c.json({ runId, routine: routineView(fired) }, 202);
  } catch (error) {
    return scheduleError(error) ?? Promise.reject(error);
  }
});

botsRoutes.get("/:id/routines/:routineId/history", async (c) => {
  const orgId = c.get("orgId");
  const id = botId(c.req.param("id"));
  const routineId = botId(c.req.param("routineId"));
  if (!id || !routineId) return c.json({ error: "not_found" }, 404);
  const routine = await getBotRoutine(orgId, id, routineId);
  if (!routine) return c.json({ error: "not_found" }, 404);
  return c.json({ firings: await listFirings(routine.id) });
});
