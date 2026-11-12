import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { bots, schedules } from "../src/db/schema";
import { clearRepoCache } from "../src/github/repos";
import { listEnabledSchedules } from "../src/schedules/repo";
import { createOrgSession, fetchApi, json, type OrgSession } from "./helpers";

// Bot export and import through the real routes and database. GitHub's repo
// listing is stubbed at globalThis.fetch (as skill-import.test does), with a PAT
// in env so auth never reaches the network; GITHUB_TENANT_ORG_ID names the
// workspace that can reach the listed repositories.

const realFetch = globalThis.fetch;
const previousBots = process.env.BOTS;
const listed = ["acme/app", "acme/docs"];
let listingFails = false;

let A: OrgSession;
let B: OrgSession;

function reachRepos(orgId: string): void {
  process.env.GITHUB_TENANT_ORG_ID = orgId;
  clearRepoCache();
}

beforeAll(async () => {
  process.env.BOTS = "1";
  process.env.GITHUB_TOKEN = "ghp_faketest_bot_transfer";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== "api.github.com") return realFetch(input as never, init);
    if (url.pathname === "/user/repos") {
      if (listingFails) return new Response(JSON.stringify({ message: "Server Error" }), { status: 500 });
      return Response.json(listed.map((full_name) => ({ full_name, name: full_name.split("/")[1], private: true, default_branch: "main", archived: false })));
    }
    throw new Error(`unexpected GitHub fetch: ${url}`);
  }) as unknown as typeof fetch;
  A = await createOrgSession("bot-export");
  B = await createOrgSession("bot-import");
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TENANT_ORG_ID;
  clearRepoCache();
  if (previousBots === undefined) delete process.env.BOTS;
  else process.env.BOTS = previousBots;
});

interface BotBody {
  id: string;
  name: string;
  title: string;
  rules: string;
  engine: string;
  model: string | null;
  repos: string[];
  memoryScope: string;
  avatarTone: string;
  avatarIcon: string;
  skillIds: string[];
  homeThreadId: string | null;
  routines: number;
  editable: boolean;
}
interface RoutineBody {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
}
interface ImportBody {
  bot: BotBody;
  routines: number;
  skipped: { repos: string[]; model: string | null };
}

function botFile(bot: Record<string, unknown> = {}, routines: unknown[] = []) {
  return { format: "useagent.bot", version: 1, bot: { name: "Imported", engine: "mock", ...bot }, routines };
}

async function botCount(orgId: string): Promise<number> {
  return (await db.select({ id: bots.id }).from(bots).where(eq(bots.orgId, orgId))).length;
}

async function scheduleCount(orgId: string): Promise<number> {
  return (await db.select({ id: schedules.id }).from(schedules).where(eq(schedules.orgId, orgId))).length;
}

describe("bot export and import", () => {
  test("a bot exported from one workspace imports into another with its routines turned off", async () => {
    reachRepos(A.orgId);
    const created = await json<{ bot: BotBody }>("/api/bots", {
      method: "POST",
      cookies: A.cookies,
      body: {
        name: "Ledger",
        title: "Data analyst",
        rules: "Numbers come from the warehouse.",
        engine: "mock",
        model: "mock-large",
        repos: ["acme/app", "acme/docs"],
        memoryScope: "personal",
        avatarTone: "violet",
        avatarIcon: "code",
      },
    });
    expect(created.status).toBe(201);
    const source = created.body.bot;
    for (const routine of [
      { name: "Weekly metrics", cron: "0 7 * * 1", timezone: "Europe/Berlin", prompt: "Build the weekly metrics workbook." },
      { name: "Daily check", cron: "30 9 * * *", prompt: "Check yesterday's numbers.", enabled: false },
    ]) {
      const added = await fetchApi(`/api/bots/${source.id}/routines`, { method: "POST", cookies: A.cookies, body: routine });
      expect(added.status).toBe(201);
    }
    // The home thread exists; none of it belongs in the file.
    const message = await json<{ id: string }>(`/api/bots/${source.id}/messages`, { method: "POST", cookies: A.cookies, body: { text: "Start the ledger." } });
    expect(message.status).toBe(201);

    const exported = await fetchApi(`/api/bots/${source.id}/export`, { cookies: A.cookies });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("application/json");
    const text = await exported.text();
    expect(JSON.parse(text)).toEqual({
      format: "useagent.bot",
      version: 1,
      bot: {
        name: "Ledger",
        title: "Data analyst",
        rules: "Numbers come from the warehouse.",
        engine: "mock",
        model: "mock-large",
        repos: ["acme/app", "acme/docs"],
        memoryScope: "personal",
        avatarTone: "violet",
        avatarIcon: "code",
      },
      routines: [
        { name: "Weekly metrics", cron: "0 7 * * 1", timezone: "Europe/Berlin", prompt: "Build the weekly metrics workbook." },
        { name: "Daily check", cron: "30 9 * * *", timezone: "UTC", prompt: "Check yesterday's numbers." },
      ],
    });
    for (const leak of [source.id, A.orgId, A.email, message.body.id, "Start the ledger."]) expect(text).not.toContain(leak);

    // The new workspace reaches only acme/app.
    listed.splice(1, 1);
    try {
      reachRepos(B.orgId);
      const imported = await json<ImportBody>("/api/bots/import", { method: "POST", cookies: B.cookies, body: text });
      expect(imported.status).toBe(201);
      expect(imported.body.skipped).toEqual({ repos: ["acme/docs"], model: null });
      expect(imported.body.routines).toBe(2);
      const bot = imported.body.bot;
      expect(bot.id).not.toBe(source.id);
      expect(bot).toMatchObject({
        name: "Ledger",
        title: "Data analyst",
        rules: "Numbers come from the warehouse.",
        engine: "mock",
        model: "mock-large",
        repos: ["acme/app"],
        memoryScope: "personal",
        avatarTone: "violet",
        avatarIcon: "code",
        skillIds: [],
        homeThreadId: null,
        routines: 0,
        editable: true,
      });

      const routines = await json<{ routines: RoutineBody[] }>(`/api/bots/${bot.id}/routines`, { cookies: B.cookies });
      expect(routines.body.routines.map(({ name, cron, timezone, prompt, enabled }) => ({ name, cron, timezone, prompt, enabled })).toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: "Daily check", cron: "30 9 * * *", timezone: "UTC", prompt: "Check yesterday's numbers.", enabled: false },
        { name: "Weekly metrics", cron: "0 7 * * 1", timezone: "Europe/Berlin", prompt: "Build the weekly metrics workbook.", enabled: false },
      ]);
      const enabled = new Set((await listEnabledSchedules()).map((schedule) => schedule.id));
      expect(routines.body.routines.some((routine) => enabled.has(routine.id))).toBe(false);
      // Each routine is an automation of the importer, carrying the bot's preset.
      const rows = await db.select().from(schedules).where(and(eq(schedules.orgId, B.orgId), eq(schedules.botId, bot.id)));
      expect(rows.map((row) => [row.engine, row.model, row.repos])).toEqual([
        ["mock", "mock-large", ["acme/app"]],
        ["mock", "mock-large", ["acme/app"]],
      ]);

      // Exporting the import gives the same file, less the skipped repository.
      const again = await json(`/api/bots/${bot.id}/export`, { cookies: B.cookies });
      const original = JSON.parse(text);
      expect(again.body).toEqual({ ...original, bot: { ...original.bot, repos: ["acme/app"] } });
    } finally {
      listed.splice(1, 0, "acme/docs");
    }
  });

  test("a hand-edited file with fields it does not know still imports", async () => {
    reachRepos(B.orgId);
    const imported = await json<ImportBody>("/api/bots/import", {
      method: "POST",
      cookies: B.cookies,
      body: {
        ...botFile(
          { name: "Scout", id: "8d1d3c52-0000-4000-8000-000000000000", skillIds: ["8d1d3c52-0000-4000-8000-000000000001"], homeThreadId: "run-1", favouriteColour: "teal" },
          [{ name: "Morning", cron: "0 8 * * *", prompt: "Read the news.", enabled: true, lastFiredAt: "2026-01-01T00:00:00Z" }],
        ),
        exportedAt: "2026-11-01T00:00:00Z",
      },
    });
    expect(imported.status).toBe(201);
    expect(imported.body.bot).toMatchObject({ name: "Scout", skillIds: [], homeThreadId: null, repos: [] });
    expect(imported.body.skipped).toEqual({ repos: [], model: null });
    const routines = await json<{ routines: RoutineBody[] }>(`/api/bots/${imported.body.bot.id}/routines`, { cookies: B.cookies });
    expect(routines.body.routines.map((routine) => [routine.name, routine.timezone, routine.enabled])).toEqual([["Morning", "UTC", false]]);
  });

  test("a malformed file fails with the field named and creates nothing", async () => {
    const bots = await botCount(B.orgId);
    const automations = await scheduleCount(B.orgId);
    const cases: [unknown, string][] = [
      ["not json at all", "file"],
      [[botFile()], "file"],
      [{ ...botFile(), format: "useagent.skill" }, "format"],
      [{ ...botFile(), version: 2 }, "version"],
      [botFile({ name: "bot/../Nova" }), "name"],
      [botFile({}, [{ name: "Fine", cron: "0 8 * * *", prompt: "Ok." }, { name: "Broken", cron: "sometimes", prompt: "Hm." }]), "routines[1].cron"],
    ];
    for (const [body, field] of cases) {
      const refused = await json<{ error: string; field: string; reason: string }>("/api/bots/import", { method: "POST", cookies: B.cookies, body: body as never });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ error: "invalid_bot_file", field });
      expect(refused.body.reason.length).toBeGreaterThan(0);
    }
    expect(await botCount(B.orgId)).toBe(bots);
    expect(await scheduleCount(B.orgId)).toBe(automations);
  });

  test("a name already taken in the workspace answers 409 on the name field", async () => {
    const first = await fetchApi("/api/bots/import", { method: "POST", cookies: B.cookies, body: botFile({ name: "Twin" }) });
    expect(first.status).toBe(201);
    const bots = await botCount(B.orgId);
    const second = await json<{ field: string; reason: string }>("/api/bots/import", { method: "POST", cookies: B.cookies, body: botFile({ name: "twin" }) });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ field: "name", reason: "A bot named Twin already exists. Choose another name." });
    expect(await botCount(B.orgId)).toBe(bots);
  });

  test("a model this workspace does not offer is left out with a note", async () => {
    const imported = await json<ImportBody>("/api/bots/import", {
      method: "POST",
      cookies: B.cookies,
      body: botFile({ name: "Modeller", engine: "opencode", model: "no-such-provider/no-such-model" }),
    });
    expect(imported.status).toBe(201);
    expect(imported.body.bot.model).toBeNull();
    expect(imported.body.skipped).toEqual({ repos: [], model: "no-such-provider/no-such-model" });
  });

  test("every repository is skipped where the workspace's GitHub listing can't confirm it", async () => {
    // Another workspace holds the GitHub connection: nothing is reachable from B.
    reachRepos(A.orgId);
    const noAccess = await json<ImportBody>("/api/bots/import", {
      method: "POST",
      cookies: B.cookies,
      body: botFile({ name: "Offline", repos: ["acme/app", "acme/docs"] }),
    });
    expect(noAccess.status).toBe(201);
    expect(noAccess.body.bot.repos).toEqual([]);
    expect(noAccess.body.skipped.repos).toEqual(["acme/app", "acme/docs"]);

    reachRepos(B.orgId);
    listingFails = true;
    try {
      const failed = await json<ImportBody>("/api/bots/import", {
        method: "POST",
        cookies: B.cookies,
        body: botFile({ name: "Unlucky", repos: ["acme/app"] }, [{ name: "Daily", cron: "0 8 * * *", prompt: "Check." }]),
      });
      expect(failed.status).toBe(201);
      expect(failed.body.bot.repos).toEqual([]);
      expect(failed.body.skipped.repos).toEqual(["acme/app"]);
      expect(failed.body.routines).toBe(1);
    } finally {
      listingFails = false;
      clearRepoCache();
    }
  });

  test("a routine that fails to save takes the new bot and earlier routines back", async () => {
    // A copy taken before the mock: the module namespace itself turns into the mock.
    const realService = { ...(await import("../src/schedules/service")) };
    let calls = 0;
    mock.module("../src/schedules/service", () => ({
      ...realService,
      createScheduleForOrg: async (...args: Parameters<typeof realService.createScheduleForOrg>) => {
        calls += 1;
        if (calls === 2) throw new realService.ScheduleServiceError(400, { error: "model_not_allowed" });
        return realService.createScheduleForOrg(...args);
      },
    }));
    try {
      const bots = await botCount(B.orgId);
      const automations = await scheduleCount(B.orgId);
      const failed = await json<{ error: string }>("/api/bots/import", {
        method: "POST",
        cookies: B.cookies,
        body: botFile({ name: "Halfway" }, [
          { name: "One", cron: "0 8 * * *", prompt: "First." },
          { name: "Two", cron: "0 9 * * *", prompt: "Second." },
        ]),
      });
      expect(failed.status).toBe(400);
      expect(failed.body.error).toBe("model_not_allowed");
      expect(calls).toBe(2);
      expect(await botCount(B.orgId)).toBe(bots);
      expect(await scheduleCount(B.orgId)).toBe(automations);
      // The name is free again.
      const retried = await fetchApi("/api/bots/import", { method: "POST", cookies: B.cookies, body: botFile({ name: "Halfway" }) });
      expect(retried.status).toBe(201);
    } finally {
      mock.module("../src/schedules/service", () => realService);
    }
  });

  test("export answers 404 for a bot of another workspace", async () => {
    const created = await json<{ bot: BotBody }>("/api/bots", { method: "POST", cookies: A.cookies, body: { name: "Private", engine: "mock" } });
    expect(created.status).toBe(201);
    expect((await fetchApi(`/api/bots/${created.body.bot.id}/export`, { cookies: B.cookies })).status).toBe(404);
    expect((await fetchApi("/api/bots/not-a-uuid/export", { cookies: A.cookies })).status).toBe(404);
  });
});
