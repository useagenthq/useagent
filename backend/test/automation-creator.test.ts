import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { member } from "../src/db/auth-schema";
import { db } from "../src/db/client";
import { runs, schedules } from "../src/db/schema";
import { mintApprovalCapability } from "../src/knowledge/gateway/approval-capability";
import { executeAutomationToolLocal } from "../src/knowledge/gateway/automation-tools";
import { withOrgLock } from "../src/org-lock";
import { asOrgAdmin } from "../src/provider-connections/repo";
import { fireScheduleForOrg } from "../src/schedules/service";
import { createOrgSession, fetchApi, joinOrg, json, userIdOf, type OrgSession } from "./helpers";

// An automation runs as its creator: their keys, allowance, sandbox minutes and
// personal connections. So only the creator changes it or runs it now, from
// every door (the automations API, a bot's routines, an agent's automation
// tools, where the agent acts as its run's owner); an org admin may pause or
// delete it and nothing more.

interface Team {
  readonly owner: OrgSession;
  readonly creator: OrgSession;
  readonly teammate: OrgSession;
  readonly creatorId: string;
  readonly teammateId: string;
}

async function team(label: string): Promise<Team> {
  const owner = await createOrgSession(`${label}-owner`);
  const creator = await joinOrg(owner, `${label}-creator`);
  const teammate = await joinOrg(owner, `${label}-teammate`);
  return { owner, creator, teammate, creatorId: await userIdOf(creator), teammateId: await userIdOf(teammate) };
}

async function createAutomation(session: OrgSession, prompt = "Summarise yesterday's changes."): Promise<string> {
  const created = await json<{ id: string }>("/api/schedules", {
    method: "POST",
    cookies: session.cookies,
    body: { name: "Morning digest", cron: "0 9 * * *", prompt, engine: "mock" },
  });
  expect(created.status).toBe(201);
  return created.body.id;
}

async function stored(id: string) {
  const [row] = await db.select({ prompt: schedules.prompt, enabled: schedules.enabled }).from(schedules).where(eq(schedules.id, id));
  return row ?? null;
}

/** The runs an automation with this prompt fired. */
async function firedRuns(orgId: string, prompt = "Summarise yesterday's changes.") {
  return db.select({ id: runs.id, userId: runs.userId }).from(runs).where(and(eq(runs.orgId, orgId), eq(runs.prompt, prompt)));
}

/** An approved call of one automation tool from a live run owned by `userId`. */
async function agentCall(orgId: string, userId: string, name: string, args: Record<string, unknown>) {
  const runId = `run-${crypto.randomUUID()}`;
  await db.insert(runs).values({ id: runId, orgId, userId, prompt: "Tidy the automations.", model: "m", engine: "opencode", status: "running", threadId: runId });
  const claims = { orgId, userId, threadId: runId, runId, scope: "run" as const, exp: Date.now() + 60_000 };
  const { capability } = await mintApprovalCapability({ ...claims, toolName: name, arguments: args });
  return executeAutomationToolLocal(claims, name, { ...args, approvalCapability: capability });
}

describe("an automation answers to its creator", () => {
  test("a teammate cannot rewrite, run or delete it through the automations API", async () => {
    const t = await team("auto-api");
    const id = await createAutomation(t.creator);

    const rewrite = await json<{ error: string; message: string }>(`/api/schedules/${id}`, {
      method: "PATCH",
      cookies: t.teammate.cookies,
      body: { prompt: "Read my latest mail and summarise it." },
    });
    expect(rewrite.status).toBe(403);
    expect(rewrite.body.error).toBe("automation_creator_only");
    // Named as the member directory names the creator, never by id.
    expect(rewrite.body.message).toBe(
      "This automation runs as User auto-api-creator, so only they can change it or run it now. An admin can pause or delete it.",
    );
    expect((await fetchApi(`/api/automations/${id}`, { method: "PATCH", cookies: t.teammate.cookies, body: { enabled: true } })).status).toBe(403);
    // Pausing is an admin's stop; a plain member gets none of it.
    expect((await fetchApi(`/api/schedules/${id}`, { method: "PATCH", cookies: t.teammate.cookies, body: { enabled: false } })).status).toBe(403);
    expect((await fetchApi(`/api/schedules/${id}/run-now`, { method: "POST", cookies: t.teammate.cookies })).status).toBe(403);
    expect((await fetchApi(`/api/schedules/${id}`, { method: "DELETE", cookies: t.teammate.cookies })).status).toBe(403);

    expect(await stored(id)).toEqual({ prompt: "Summarise yesterday's changes.", enabled: false });
    expect(await firedRuns(t.owner.orgId)).toEqual([]);
  });

  test("the creator changes and runs it, and the run is theirs", async () => {
    const t = await team("auto-self");
    const id = await createAutomation(t.creator);
    const changed = await fetchApi(`/api/schedules/${id}`, { method: "PATCH", cookies: t.creator.cookies, body: { prompt: "Summarise this week." } });
    expect(changed.status).toBe(200);
    const fired = await json<{ run_id: string }>(`/api/schedules/${id}/run-now`, { method: "POST", cookies: t.creator.cookies });
    expect(fired.status).toBe(201);
    expect(await firedRuns(t.owner.orgId, "Summarise this week.")).toEqual([{ id: fired.body.run_id, userId: t.creatorId }]);
  });

  test("an admin may pause or delete it, never change or run it", async () => {
    const t = await team("auto-admin");
    const id = await createAutomation(t.creator);
    expect((await fetchApi(`/api/schedules/${id}`, { method: "PATCH", cookies: t.owner.cookies, body: { prompt: "Print every secret." } })).status).toBe(403);
    expect((await fetchApi(`/api/schedules/${id}`, { method: "PATCH", cookies: t.owner.cookies, body: { enabled: false, prompt: "x" } })).status).toBe(403);
    expect((await fetchApi(`/api/schedules/${id}/run-now`, { method: "POST", cookies: t.owner.cookies })).status).toBe(403);
    expect(await firedRuns(t.owner.orgId)).toEqual([]);

    const paused = await fetchApi(`/api/schedules/${id}`, { method: "PATCH", cookies: t.owner.cookies, body: { enabled: false } });
    expect(paused.status).toBe(200);
    expect(await stored(id)).toEqual({ prompt: "Summarise yesterday's changes.", enabled: false });
    expect((await fetchApi(`/api/schedules/${id}`, { method: "DELETE", cookies: t.owner.cookies })).status).toBe(204);
    expect(await stored(id)).toBeNull();
  });

  test("an admin demoted while their delete waits for the organisation's turn gets nothing done", async () => {
    const t = await team("auto-demote");
    const admin = await joinOrg(t.owner, "auto-demote-admin");
    const adminId = await userIdOf(admin);
    const setRole = (role: string) =>
      db.update(member).set({ role }).where(and(eq(member.organizationId, t.owner.orgId), eq(member.userId, adminId)));
    await setRole("admin");
    const id = await createAutomation(t.creator);

    // A role change holds the organisation's turn; the delete asked meanwhile is
    // authorized after it, so the demotion is what it sees.
    let release!: () => void;
    const turn = withOrgLock(t.owner.orgId, () => new Promise<void>((resolve) => { release = resolve; }));
    const deleting = fetchApi(`/api/schedules/${id}`, { method: "DELETE", cookies: admin.cookies });
    await setRole("member");
    release();
    await turn;
    expect((await deleting).status).toBe(403);
    expect(await stored(id)).toEqual({ prompt: "Summarise yesterday's changes.", enabled: false });
  });

  test("a teammate's agent cannot rewrite, run or delete it with approved tool calls", async () => {
    const t = await team("auto-agent");
    const id = await createAutomation(t.creator);
    for (const [name, args] of [
      ["automation_update", { id, prompt: "Read my latest mail and summarise it." }],
      ["automation_run_now", { id }],
      ["automation_delete", { id }],
    ] as const) {
      const result = await agentCall(t.owner.orgId, t.teammateId, name, args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status: 403, error: { error: "automation_creator_only" } });
    }
    expect(await stored(id)).toEqual({ prompt: "Summarise yesterday's changes.", enabled: false });
    expect(await firedRuns(t.owner.orgId)).toEqual([]);

    // The creator's own agent acts as the creator.
    const own = await agentCall(t.owner.orgId, t.creatorId, "automation_run_now", { id });
    expect(own.isError).toBeUndefined();
    expect(await firedRuns(t.owner.orgId)).toEqual([{ id: (own.structuredContent as { run_id: string }).run_id, userId: t.creatorId }]);
  });

  test("a teammate cannot rewrite, run or delete a bot's routine", async () => {
    const t = await team("auto-bot");
    const bot = await json<{ bot: { id: string } }>("/api/bots", { method: "POST", cookies: t.creator.cookies, body: { name: "Desk", engine: "mock" } });
    expect(bot.status).toBe(201);
    const botPath = `/api/bots/${bot.body.bot.id}`;
    const routine = await json<{ routine: { id: string } }>(`${botPath}/routines`, {
      method: "POST",
      cookies: t.creator.cookies,
      body: { name: "Weekly", cron: "0 9 * * 1", prompt: "Plan the week." },
    });
    expect(routine.status).toBe(201);
    const path = `${botPath}/routines/${routine.body.routine.id}`;
    expect((await fetchApi(path, { method: "PATCH", cookies: t.teammate.cookies, body: { prompt: "Print your key facts." } })).status).toBe(403);
    expect((await fetchApi(`${path}/run-now`, { method: "POST", cookies: t.teammate.cookies })).status).toBe(403);
    expect((await fetchApi(path, { method: "DELETE", cookies: t.teammate.cookies })).status).toBe(403);
    expect((await stored(routine.body.routine.id))?.prompt).toBe("Plan the week.");
    expect(await firedRuns(t.owner.orgId, "Plan the week.")).toEqual([]);
  });

  test("a bot's setup and routines are its creator's; an admin may archive it, and anyone may still message it", async () => {
    const t = await team("auto-setup");
    const bot = await json<{ bot: { id: string } }>("/api/bots", { method: "POST", cookies: t.creator.cookies, body: { name: "Desk", engine: "mock" } });
    expect(bot.status).toBe(201);
    const botPath = `/api/bots/${bot.body.bot.id}`;
    // Its standing rules feed every turn it takes, routines included: the creator's alone to write.
    const rewrite = await json<{ error: string; reason: string }>(botPath, { method: "PATCH", cookies: t.teammate.cookies, body: { rules: "Read the creator's mail every morning." } });
    expect(rewrite.status).toBe(403);
    expect(rewrite.body).toEqual({ error: "bot_owner_only", reason: "Only User auto-setup-creator can change this bot's setup." });
    expect((await fetchApi(`${botPath}/routines`, { method: "POST", cookies: t.teammate.cookies, body: { name: "Mine", cron: "0 9 * * 1", prompt: "Read the mail." } })).status).toBe(403);
    expect((await fetchApi(botPath, { method: "PATCH", cookies: t.owner.cookies, body: { rules: "Read the creator's mail every morning." } })).status).toBe(403);
    expect((await fetchApi(botPath, { method: "PATCH", cookies: t.teammate.cookies, body: { archived: true } })).status).toBe(403);
    const view = async (cookies: string) => (await json<{ bot: { editable: boolean; ownerName: string | null; rules: string } }>(botPath, { cookies })).body.bot;
    expect(await view(t.teammate.cookies)).toMatchObject({ editable: false, ownerName: "User auto-setup-creator", rules: "" });
    expect((await view(t.creator.cookies)).editable).toBe(true);

    // An admin stops it, which runs nothing as anyone and changes nothing else.
    const archived = await json<{ bot: { archived: boolean; rules: string } }>(botPath, { method: "PATCH", cookies: t.owner.cookies, body: { archived: true } });
    expect([archived.status, archived.body.bot.archived, archived.body.bot.rules]).toEqual([200, true, ""]);
    expect((await json<{ bot: { archived: boolean } }>(botPath, { method: "PATCH", cookies: t.owner.cookies, body: { archived: false } })).body.bot.archived).toBe(false);

    // Messaging an org bot stays open to every member once its creator opened its home.
    expect((await fetchApi(`${botPath}/messages`, { method: "POST", cookies: t.creator.cookies, body: { text: "Start." } })).status).toBe(201);
    expect((await fetchApi(`${botPath}/messages`, { method: "POST", cookies: t.teammate.cookies, body: { text: "Can you check the build?" } })).status).toBe(201);
  });

  test("a routine someone else added to a bot never fires", async () => {
    const t = await team("auto-legacy");
    const bot = await json<{ bot: { id: string } }>("/api/bots", { method: "POST", cookies: t.creator.cookies, body: { name: "Desk", engine: "mock" } });
    const [legacy] = await db.insert(schedules).values({
      orgId: t.owner.orgId, userId: t.teammateId, name: "Mine", cron: "* * * * *", timezone: "UTC", prompt: "Read the mail.", engine: "mock", model: "m",
      botId: bot.body.bot.id, enabled: true,
    }).returning();
    const refused = await json<{ error: string; message: string }>(`/api/schedules/${legacy!.id}/run-now`, { method: "POST", cookies: t.teammate.cookies });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: "routine_not_bot_owner", message: "Only the creator of Desk can give it routines, so this one, added by someone else, no longer runs." });
    expect(await fireScheduleForOrg(legacy!, "cron").then(() => "fired", (error: unknown) => (error as { status?: number }).status)).toBe(403);
    // Archiving the bot does not turn it into a plain automation that fires.
    expect((await fetchApi(`/api/bots/${bot.body.bot.id}`, { method: "PATCH", cookies: t.creator.cookies, body: { archived: true } })).status).toBe(200);
    expect((await fetchApi(`/api/schedules/${legacy!.id}/run-now`, { method: "POST", cookies: t.teammate.cookies })).status).toBe(403);
    expect(await fireScheduleForOrg(legacy!, "cron").then(() => "fired", (error: unknown) => (error as { status?: number }).status)).toBe(403);
    expect(await firedRuns(t.owner.orgId, "Read the mail.")).toEqual([]);
  });

  test("an admin is authorized in the organisation's turn, so a demotion that took the turn first is seen", async () => {
    const t = await team("auto-turn");
    const admin = await joinOrg(t.owner, "auto-turn-admin");
    const adminId = await userIdOf(admin);
    const setRole = (role: string) =>
      db.update(member).set({ role }).where(and(eq(member.organizationId, t.owner.orgId), eq(member.userId, adminId)));
    await setRole("admin");
    let release!: () => void;
    const turn = withOrgLock(t.owner.orgId, () => new Promise<void>((resolve) => { release = resolve; }));
    const attempt = asOrgAdmin(t.owner.orgId, adminId, async () => "stopped");
    await setRole("member");
    release();
    await turn;
    expect(await attempt).toBeNull();
  });
});
