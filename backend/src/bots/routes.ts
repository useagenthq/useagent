import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { handleRunCreate } from "../runs/routes";
import type { RunCreateBody } from "../runs/run-create-policy";
import {
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

/**
 * /api/bots - a bot is a preset over a durable home thread. Messages go
 * through the same run-create door as every other turn (`handleRunCreate`),
 * so bots inherit idempotency, resource intake, skill pinning, fleet limits,
 * and the thread stream for free. The only thing this module adds is the
 * preset and, on the first message, the standing-rules root turn.
 */
export const botsRoutes = new Hono<AppEnv>();
botsRoutes.use("*", orgScope);
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

botsRoutes.get("/", async (c) => {
  const rows = await listBotRows(c.get("orgId"));
  return c.json({ bots: await describeBots(c.get("orgId"), rows) });
});

botsRoutes.post("/", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  const parsed = parseBotInput(body, null);
  if ("error" in parsed) return c.json({ error: "invalid_bot", ...parsed.error }, 400);
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
  const row = await getBotRow(c.get("orgId"), c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ bot: await describeBot(c.get("orgId"), row) });
});

botsRoutes.patch("/:id", async (c) => {
  const row = await getBotRow(c.get("orgId"), c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const body = await readBody(c);
  if (!body) return c.json({ error: "invalid_body" }, 400);
  const parsed = parseBotInput(body, rowToInput(row));
  if ("error" in parsed) return c.json({ error: "invalid_bot", ...parsed.error }, 400);
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
 * plain follow-ups chained under the thread head. Returns the run-create
 * response unchanged (201 accepted, 200 idempotent replay, 4xx policy).
 */
botsRoutes.post("/:id/messages", async (c) => {
  const orgId = c.get("orgId");
  const row = await getBotRow(orgId, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const body = await readBody(c);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text_required" }, 400);
  if (text.length > MESSAGE_MAX) return c.json({ error: "text_too_long", max: MESSAGE_MAX }, 400);

  const head = row.homeThreadId ? await latestRunInThread(orgId, row.homeThreadId) : null;
  const skillId = row.skillIds[0];
  const runBody: RunCreateBody = {
    prompt: head ? text : composeRootPrompt(row, text),
    engine: row.engine,
    ...(row.model ? { model: row.model } : {}),
    ...(head ? { parent_run_id: head.id } : { memory_scope: row.memoryScope }),
    ...(row.repos.length > 0 && !head ? { repos: [...row.repos] } : {}),
    ...(skillId && !head ? { skill: { id: skillId } } : {}),
  };
  const response = await handleRunCreate(c, { body: runBody });
  if (!head && response.status === 201) {
    const accepted = (await response.clone().json()) as { id?: unknown };
    if (typeof accepted.id === "string") await setBotHomeThread(orgId, row.id, accepted.id);
  }
  return response;
});

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code
    ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "23505";
}
