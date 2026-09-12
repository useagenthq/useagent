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
  composeRootPrompt,
  createBotRow,
  describeBot,
  describeBots,
  getBotRow,
  latestRunInThread,
  listBotRows,
  parseBotInput,
  rowToInput,
  setBotHomeThread,
  updateBotRow,
} from "./repo";
import { botsEnabled } from "./rollout";

const MESSAGE_MAX = 20_000;
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

/** Live-config checks a structurally valid preset still has to pass. */
async function checkPreset(orgId: string, input: BotInput): Promise<PresetProblem | null> {
  const engine = resolveAcceptedEngine(input.engine);
  if (!engine.ok) return { status: engine.status, body: { ...engineResolutionErrorBody(engine), field: "engine" } };
  if (input.model && !isModelAllowedForEngine(input.engine, input.model)) {
    return { status: 400, body: { error: "model_not_allowed", field: "model", reason: `${input.model} is not offered for ${input.engine}` } };
  }
  const skillId = input.skillIds[0];
  if (skillId) {
    const pinned = await resolveSkillSelection(orgId, { id: skillId }).catch(() => null);
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
  const problem = await checkPreset(c.get("orgId"), parsed.input);
  if (problem) return c.json(problem.body, problem.status);
  try {
    const row = await createBotRow(c.get("orgId"), parsed.input, c.get("userId"));
    return c.json({ bot: await describeBot(c.get("orgId"), row) }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return c.json({ error: "invalid_bot", field: "name", reason: "a bot with this name already exists" }, 409);
    }
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
  // The home thread already runs on the stored preset; a changed engine would
  // 400 every follow-up and changed skills/repos/scope would silently not apply.
  const locked = row.homeThreadId ? changedPresetFields(base, parsed.input) : [];
  if (locked.length > 0) {
    return c.json(
      { error: "preset_locked", fields: locked, reason: "engine, model, skills, repos and memory scope are fixed once the bot has a home thread" },
      409,
    );
  }
  const problem = await checkPreset(c.get("orgId"), parsed.input);
  if (problem) return c.json(problem.body, problem.status);
  try {
    const updated = await updateBotRow(c.get("orgId"), row.id, parsed.input);
    if (!updated) return c.json({ error: "not_found" }, 404);
    return c.json({ bot: await describeBot(c.get("orgId"), updated) });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return c.json({ error: "invalid_bot", field: "name", reason: "a bot with this name already exists" }, 409);
    }
    throw error;
  }
});

/**
 * Message the bot. First message: a root run with the preset and the
 * standing-rules preamble, which becomes the home thread. Later messages:
 * plain follow-ups chained under the thread head (engine, model, skills,
 * repos and scope are inherited from the thread, never re-sent). Returns the
 * run-create response unchanged (201 accepted, 200 idempotent replay, 4xx).
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
    prompt: composeRootPrompt(row, text),
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
    await acceptRunCancel({ orgId, actorId: c.get("userId"), runId: accepted.id });
    return c.json({ error: "home_thread_already_created", homeThreadId: current?.homeThreadId ?? null }, 409);
  }
  return response;
});
