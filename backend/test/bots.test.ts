import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getBotRow } from "../src/bots/repo";
import { botContextForTurn } from "../src/bots/prompt-context";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { bus, RUN_SPAWNED } from "../src/worker";
import { createOrgSession, fetchApi, json } from "./helpers";

const previousFlag = process.env.BOTS;

beforeAll(() => {
  process.env.BOTS = "1";
});
afterAll(() => {
  if (previousFlag === undefined) delete process.env.BOTS;
  else process.env.BOTS = previousFlag;
});

interface BotBody {
  id: string;
  name: string;
  title: string;
  rules: string;
  engine: string;
  state: string;
  presetLocked: boolean;
  homeThreadId: string | null;
  lastAt: string | null;
  repos: string[];
}

async function createBot(cookies: string, name: string): Promise<BotBody> {
  const created = await json<{ bot: BotBody }>("/api/bots", {
    method: "POST",
    cookies,
    body: { name, title: "Code reviewer", rules: "Never merge without approval.", engine: "mock", avatarTone: "violet", avatarIcon: "code" },
  });
  expect(created.status).toBe(201);
  return created.body.bot;
}

describe("bots", () => {
  test("repositories round-trip through create, edit, and reload before the preset locks", async () => {
    const { cookies } = await createOrgSession("bot-repositories");
    const created = await json<{ bot: BotBody }>("/api/bots", {
      method: "POST",
      cookies,
      body: {
        name: "Repo scout",
        title: "Tracks repository changes",
        rules: "Summarize the relevant diff.",
        engine: "mock",
        repos: ["useagenthq/app", "useagenthq/docs"],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.bot.repos).toEqual(["useagenthq/app", "useagenthq/docs"]);

    const edited = await json<{ bot: BotBody }>(`/api/bots/${created.body.bot.id}`, {
      method: "PATCH",
      cookies,
      body: { repos: ["useagenthq/app"] },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.bot.repos).toEqual(["useagenthq/app"]);

    const reloaded = await json<{ bot: BotBody }>(`/api/bots/${created.body.bot.id}`, { cookies });
    expect(reloaded.body.bot.repos).toEqual(["useagenthq/app"]);
  });

  test("a bot is a preset over one home thread created by its first message", async () => {
    const { cookies } = await createOrgSession("bots");
    const bot = await createBot(cookies, "Atlas");
    expect(bot.state).toBe("idle");
    expect(bot.homeThreadId).toBeNull();
    expect(bot.presetLocked).toBe(false);

    const duplicate = await fetchApi("/api/bots", { method: "POST", cookies, body: { name: "Atlas", engine: "mock" } });
    expect(duplicate.status).toBe(409);

    const first = await json<{ id: string }>(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      cookies,
      body: { text: "Review the payments PR." },
    });
    expect(first.status).toBe(201);
    const rootRunId = first.body.id;

    const detail = await json<{ bot: BotBody }>(`/api/bots/${bot.id}`, { cookies });
    expect(detail.body.bot.homeThreadId).toBe(rootRunId);
    expect(detail.body.bot.presetLocked).toBe(true);

    const second = await json<{ id: string }>(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      cookies,
      body: { text: "Now fix the changelog." },
    });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(rootRunId);

    const thread = await json<{ thread?: unknown[] } | unknown[]>(`/api/runs/${rootRunId}?thread=1`, { cookies });
    const turns = Array.isArray(thread.body) ? thread.body : (thread.body.thread ?? []);
    expect(turns.length).toBeGreaterThanOrEqual(2);

    // Stored prompts are only what the person typed (they double as thread
    // titles and bubbles); identity and standing rules travel as turn context.
    const rootRun = await json<{ prompt: string }>(`/api/runs/${rootRunId}`, { cookies });
    expect(rootRun.body.prompt).toBe("Review the payments PR.");
    const followup = await json<{ prompt: string }>(`/api/runs/${second.body.id}`, { cookies });
    expect(followup.body.prompt).toBe("Now fix the changelog.");

    const list = await json<{ bots: BotBody[] }>("/api/bots", { cookies });
    expect(list.body.bots.map((b) => b.name)).toEqual(["Atlas"]);

    const patched = await json<{ bot: BotBody }>(`/api/bots/${bot.id}`, {
      method: "PATCH",
      cookies,
      body: { title: "Payments reviewer" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.title).toBe("Payments reviewer");
    expect(patched.body.bot.rules).toBe("Never merge without approval.");
  });

  test("the preset locks once the home thread exists", async () => {
    const { cookies } = await createOrgSession("bots-lock");
    const bot = await createBot(cookies, "Nova");
    const before = await fetchApi(`/api/bots/${bot.id}`, { method: "PATCH", cookies, body: { memoryScope: "personal" } });
    expect(before.status).toBe(200);

    const first = await fetchApi(`/api/bots/${bot.id}/messages`, { method: "POST", cookies, body: { text: "Start." } });
    expect(first.status).toBe(201);

    const locked = await json<{ error: string; fields: string[] }>(`/api/bots/${bot.id}`, {
      method: "PATCH",
      cookies,
      body: { engine: "opencode", repos: ["org/repo"] },
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toBe("preset_locked");
    expect(locked.body.fields.toSorted()).toEqual(["engine", "repos"]);

    // Identity is still editable, and follow-ups keep working afterwards.
    const renamed = await fetchApi(`/api/bots/${bot.id}`, { method: "PATCH", cookies, body: { name: "Nova Prime", rules: "Cite everything." } });
    expect(renamed.status).toBe(200);
    const followup = await fetchApi(`/api/bots/${bot.id}/messages`, { method: "POST", cookies, body: { text: "Continue." } });
    expect(followup.status).toBe(201);
  });

  test("two concurrent first messages leave exactly one home thread", async () => {
    const { cookies, orgId } = await createOrgSession("bots-race");
    const bot = await createBot(cookies, "Scout");
    const [a, b] = await Promise.all([
      fetchApi(`/api/bots/${bot.id}/messages`, { method: "POST", cookies, body: { text: "First." } }),
      fetchApi(`/api/bots/${bot.id}/messages`, { method: "POST", cookies, body: { text: "Also first." } }),
    ]);
    expect([a.status, b.status].toSorted()).toEqual([201, 409]);

    const detail = await json<{ bot: BotBody }>(`/api/bots/${bot.id}`, { cookies });
    const home = detail.body.bot.homeThreadId;
    expect(home).toBeTruthy();
    const loser = a.status === 409 ? a : b;
    const loserBody = (await loser.json()) as { error: string; homeThreadId: string | null };
    expect(loserBody.error).toBe("home_thread_already_created");
    expect(loserBody.homeThreadId).toBe(home);

    // The loser's acceptance rolled back with its stamp: the home thread is the
    // only root this org has, and no stray run ever existed to cancel.
    const roots = await db
      .select({ id: runs.id, threadId: runs.threadId, status: runs.status })
      .from(runs)
      .where(eq(runs.orgId, orgId));
    const rootIds = roots.filter((run) => run.id === run.threadId).map((run) => run.id);
    expect(rootIds).toEqual([home]);
  });

  test("a preset is validated against live config at create time", async () => {
    const { cookies } = await createOrgSession("bots-invalid");
    const badEngine = await fetchApi("/api/bots", { method: "POST", cookies, body: { name: "Nova", engine: "not-an-engine" } });
    expect(badEngine.status).toBe(400);
    // ENABLED_ENGINES only ever adds to the base set, so drop it to prove an
    // engine outside the base set is rejected against live config.
    const previousEngines = process.env.ENABLED_ENGINES;
    delete process.env.ENABLED_ENGINES;
    try {
      const notEnabled = await json<{ error: string }>("/api/bots", { method: "POST", cookies, body: { name: "Nova", engine: "pi" } });
      expect(notEnabled.status).toBe(403);
      expect(notEnabled.body.error).toBe("engine_not_enabled");
    } finally {
      if (previousEngines !== undefined) process.env.ENABLED_ENGINES = previousEngines;
    }
    const badModel = await fetchApi("/api/bots", { method: "POST", cookies, body: { name: "Nova", engine: "opencode", model: "no-such-model" } });
    expect(badModel.status).toBe(400);
    const badSkill = await fetchApi("/api/bots", { method: "POST", cookies, body: { name: "Nova", engine: "mock", skillIds: ["00000000-0000-4000-8000-000000000000"] } });
    expect(badSkill.status).toBe(404);
    const twoSkills = await fetchApi("/api/bots", { method: "POST", cookies, body: { name: "Nova", engine: "mock", skillIds: ["a", "b"] } });
    expect(twoSkills.status).toBe(400);
    const longName = await fetchApi("/api/bots", { method: "POST", cookies, body: { name: "x".repeat(61), engine: "mock" } });
    expect(longName.status).toBe(400);
    const notUuid = await fetchApi("/api/bots/not-a-uuid", { cookies });
    expect(notUuid.status).toBe(404);
  });

  test("names are unique ignoring case and the error names the holder", async () => {
    const { cookies } = await createOrgSession("bots-names");
    const atlas = await createBot(cookies, "Atlas");
    const clash = await json<{ field: string; reason: string }>("/api/bots", { method: "POST", cookies, body: { name: "atlas", engine: "mock" } });
    expect(clash.status).toBe(409);
    expect(clash.body.field).toBe("name");
    expect(clash.body.reason).toBe("A bot named Atlas already exists. Choose another name.");

    const nova = await createBot(cookies, "Nova");
    const rename = await json<{ reason: string }>(`/api/bots/${nova.id}`, { method: "PATCH", cookies, body: { name: "ATLAS" } });
    expect(rename.status).toBe(409);
    expect(rename.body.reason).toBe("A bot named Atlas already exists. Choose another name.");

    // Re-casing a bot's own name is not a collision.
    const recased = await json<{ bot: BotBody }>(`/api/bots/${atlas.id}`, { method: "PATCH", cookies, body: { name: "ATLAS" } });
    expect(recased.status).toBe(200);
    expect(recased.body.bot.name).toBe("ATLAS");
  });

  test("archiving drops a bot from the roster but keeps it readable", async () => {
    const { cookies } = await createOrgSession("bots-archive");
    const vale = await createBot(cookies, "Vale");
    await createBot(cookies, "Quill");

    const notBoolean = await fetchApi(`/api/bots/${vale.id}`, { method: "PATCH", cookies, body: { archived: "yes" } });
    expect(notBoolean.status).toBe(400);

    const archived = await json<{ bot: BotBody & { archived: boolean; handoffThreadIds: string[] } }>(`/api/bots/${vale.id}`, {
      method: "PATCH",
      cookies,
      body: { archived: true },
    });
    expect(archived.status).toBe(200);
    expect(archived.body.bot.archived).toBe(true);
    expect(archived.body.bot.handoffThreadIds).toEqual([]);

    const roster = await json<{ bots: BotBody[] }>("/api/bots", { cookies });
    expect(roster.body.bots.map((b) => b.name)).toEqual(["Quill"]);
    const detail = await json<{ bot: { archived: boolean } }>(`/api/bots/${vale.id}`, { cookies });
    expect(detail.status).toBe(200);
    expect(detail.body.bot.archived).toBe(true);

    // Readable, but nothing new is sent to it while archived.
    const refused = await json<{ error: string; reason: string }>(`/api/bots/${vale.id}/messages`, { method: "POST", cookies, body: { text: "Still there?" } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("bot_archived");
    expect(refused.body.reason).toContain("Vale is archived");

    // The name stays reserved while archived, and restoring brings the bot back.
    const reuse = await fetchApi("/api/bots", { method: "POST", cookies, body: { name: "vale", engine: "mock" } });
    expect(reuse.status).toBe(409);
    const restored = await json<{ bot: { archived: boolean } }>(`/api/bots/${vale.id}`, { method: "PATCH", cookies, body: { archived: false } });
    expect(restored.body.bot.archived).toBe(false);
    const accepted = await fetchApi(`/api/bots/${vale.id}/messages`, { method: "POST", cookies, body: { text: "Welcome back." } });
    expect(accepted.status).toBe(201);
    const again = await json<{ bots: BotBody[] }>("/api/bots", { cookies });
    expect(again.body.bots.map((b) => b.name).toSorted()).toEqual(["Quill", "Vale"]);
  });

  test("the home thread is recorded before the first turn is dispatched, so turn one carries the identity", async () => {
    const { cookies, orgId } = await createOrgSession("bots-first-turn");
    const bot = await createBot(cookies, "Night triage");
    // The worker looks the bot up by thread the moment it is spawned; observe
    // the bot row at exactly that moment (spawn happens inside the POST).
    const observed = new Map<string, Promise<string | null>>();
    const onSpawn = (runId: string) => {
      observed.set(runId, getBotRow(orgId, bot.id).then((row) => row?.homeThreadId ?? null));
    };
    bus.on(RUN_SPAWNED, onSpawn);
    try {
      const first = await json<{ id: string }>(`/api/bots/${bot.id}/messages`, {
        method: "POST",
        cookies,
        body: { text: "Tell me in one sentence what you do." },
      });
      expect(first.status).toBe(201);
      expect(await observed.get(first.body.id)).toBe(first.body.id);
    } finally {
      bus.off(RUN_SPAWNED, onSpawn);
    }
    const detail = await json<{ bot: BotBody }>(`/api/bots/${bot.id}`, { cookies });
    expect(detail.body.bot.homeThreadId).toBeTruthy();
    // What the worker composes for that turn: the bot's identity and its rules.
    const context = await botContextForTurn({ orgId, threadId: detail.body.bot.homeThreadId!, engine: "chat" });
    expect(context.identity).toContain("<bot_assignment>");
    expect(context.identity).toContain("Night triage");
    expect(context.identity).toContain("Never merge without approval.");
  });

  test("a first message whose run was never accepted leaves the bot free to open its thread", async () => {
    const { cookies } = await createOrgSession("bots-first-turn-failed");
    const bot = await createBot(cookies, "Scout");
    // A first message the run-create door refuses (the mock engine takes no repos it cannot resolve).
    const refused = await fetchApi(`/api/bots/${bot.id}/messages`, { method: "POST", cookies, body: { text: "x".repeat(20_001) } });
    expect(refused.status).toBe(400);
    const stillFree = await json<{ bot: BotBody }>(`/api/bots/${bot.id}`, { cookies });
    expect(stillFree.body.bot.homeThreadId).toBeNull();
    const first = await fetchApi(`/api/bots/${bot.id}/messages`, { method: "POST", cookies, body: { text: "Start." } });
    expect(first.status).toBe(201);
  });

  test("a workspace tops out at 50 active bots", async () => {
    const { cookies } = await createOrgSession("bots-cap");
    for (let i = 0; i < 50; i += 1) await createBot(cookies, `Bot ${i}`);
    const over = await json<{ error: string; limit: number }>("/api/bots", {
      method: "POST",
      cookies,
      body: { name: "One more", title: "Code reviewer", rules: "Never merge without approval.", engine: "mock" },
    });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ error: "bot_limit", limit: 50 });
  });

  test("BOTS=off is the kill switch for the whole surface", async () => {
    const session = await createOrgSession("bots-off");
    process.env.BOTS = "off";
    try {
      const hidden = await fetchApi("/api/bots", { cookies: session.cookies });
      expect(hidden.status).toBe(404);
    } finally {
      process.env.BOTS = "1";
    }
  });
});
