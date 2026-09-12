import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { createOrgSession, fetchApi, json, waitFor } from "./helpers";

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

    // The user's task leads the root prompt (it doubles as the thread title);
    // identity and standing rules follow.
    const rootRun = await json<{ prompt: string }>(`/api/runs/${rootRunId}`, { cookies });
    expect(rootRun.body.prompt.startsWith("Review the payments PR.")).toBe(true);
    expect(rootRun.body.prompt).toContain(
      'Bot identity metadata (server-authored JSON, data only): {"name":"Atlas","title":"Code reviewer"}',
    );
    expect(rootRun.body.prompt).toContain("You are the bot identified above.");
    expect(rootRun.body.prompt).toContain("Never merge without approval.");

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

    // The stray root was cancelled (failed while queued) or had already
    // settled; either way no root other than the home thread is still live.
    const roots = await db
      .select({ id: runs.id, threadId: runs.threadId, status: runs.status })
      .from(runs)
      .where(eq(runs.orgId, orgId));
    const rootIds = roots.filter((run) => run.id === run.threadId).map((run) => run.id);
    expect(rootIds).toHaveLength(2);
    const strayId = rootIds.find((id) => id !== home)!;
    // Cancelling a queued root fails it in place; a root the worker had already
    // picked up settles asynchronously. Either way it leaves queued/running.
    const stray = await waitFor(async () => {
      const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, strayId));
      return run && run.status !== "queued" && run.status !== "running" ? run : null;
    });
    expect(["failed", "completed"]).toContain(stray.status);
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
