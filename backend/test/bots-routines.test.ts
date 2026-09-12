import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { acceptUnattendedRunCommand, type RunCommandIntent } from "../src/commands";
import { acceptRunCancel } from "../src/commands/cancel";
import { botFiringTarget } from "../src/bots/repo";
import { APPROVAL_REQUEST_TTL_MS, BOT_REQUEST_TTL_MS, createApprovalRequest } from "../src/knowledge/gateway/approval-requests";
import { acceptExistingThreadFollowup } from "../src/runs/thread-followups";
import { fireScheduleWithOutcome, firingKey } from "../src/schedules/fire";
import { getScheduleForOrg, listEnabledSchedules } from "../src/schedules/repo";
import { tick } from "../src/schedules/scheduler";
import { fireScheduleForOrg } from "../src/schedules/service";
import { AUTOMATION_RUN_ORIGIN } from "../src/runs/origin";
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
  homeThreadId: string | null;
  routines: number;
}
interface RoutineBody {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
}

async function createBot(cookies: string, name: string): Promise<BotBody> {
  const created = await json<{ bot: BotBody }>("/api/bots", {
    method: "POST",
    cookies,
    body: { name, title: "Data analyst", rules: "Numbers come from the warehouse.", engine: "mock" },
  });
  expect(created.status).toBe(201);
  return created.body.bot;
}

describe("bot routines", () => {
  test("a routine fires into the bot's home thread, opening it on the first firing", async () => {
    const { cookies, orgId } = await createOrgSession("bot-routines");
    const bot = await createBot(cookies, "Ledger");

    const created = await json<{ routine: RoutineBody }>(`/api/bots/${bot.id}/routines`, {
      method: "POST",
      cookies,
      body: { name: "Weekly metrics", cron: "0 7 * * 1", prompt: "Build the weekly metrics workbook." },
    });
    expect(created.status).toBe(201);
    expect(created.body.routine.enabled).toBe(true);
    const routineId = created.body.routine.id;

    const listed = await json<{ routines: RoutineBody[] }>(`/api/bots/${bot.id}/routines`, { cookies });
    expect(listed.body.routines.map((r) => r.name)).toEqual(["Weekly metrics"]);
    const withCount = await json<{ bot: BotBody }>(`/api/bots/${bot.id}`, { cookies });
    expect(withCount.body.bot.routines).toBe(1);

    // First firing: no home thread yet -> it opens one with the standing rules.
    const first = await json<{ runId: string; routine: RoutineBody }>(`/api/bots/${bot.id}/routines/${routineId}/run-now`, { method: "POST", cookies });
    expect(first.status).toBe(202);
    // The response carries the routine as fired, so the row can show the run without a refetch.
    expect(first.body.routine.id).toBe(routineId);
    expect(first.body.routine.lastFiredAt).not.toBeNull();
    const afterFirst = await json<{ bot: BotBody }>(`/api/bots/${bot.id}`, { cookies });
    expect(afterFirst.body.bot.homeThreadId).toBe(first.body.runId);
    const rootRun = await json<{ prompt: string; parent_run_id: string | null }>(`/api/runs/${first.body.runId}`, { cookies });
    // The routine's own text is the stored prompt; the bot's rules travel as turn context.
    expect(rootRun.body.prompt).toBe("Build the weekly metrics workbook.");

    // Second firing: a follow-up under the home thread, not a new root.
    const second = await json<{ runId: string }>(`/api/bots/${bot.id}/routines/${routineId}/run-now`, { method: "POST", cookies });
    expect(second.status).toBe(202);
    expect(second.body.runId).not.toBe(first.body.runId);
    const [secondRun] = await db
      .select({ threadId: runs.threadId, parentRunId: runs.parentRunId, prompt: runs.prompt })
      .from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.id, second.body.runId)));
    expect(secondRun?.threadId).toBe(first.body.runId);
    expect(secondRun?.parentRunId).toBeTruthy();
    expect(secondRun?.prompt).toBe("Build the weekly metrics workbook.");

    const history = await json<{ firings: { run_id: string }[] }>(`/api/bots/${bot.id}/routines/${routineId}/history`, { cookies });
    expect(history.body.firings.map((f) => f.run_id).toSorted()).toEqual([first.body.runId, second.body.runId].toSorted());

    // Pause, then delete.
    const paused = await json<{ routine: RoutineBody }>(`/api/bots/${bot.id}/routines/${routineId}`, {
      method: "PATCH",
      cookies,
      body: { enabled: false, engine: "opencode" },
    });
    expect(paused.status).toBe(200);
    expect(paused.body.routine.enabled).toBe(false);
    const afterPause = await json<{ bot: BotBody }>(`/api/bots/${bot.id}`, { cookies });
    expect(afterPause.body.bot.routines).toBe(0);

    const removed = await fetchApi(`/api/bots/${bot.id}/routines/${routineId}`, { method: "DELETE", cookies });
    expect(removed.status).toBe(204);
    const gone = await json<{ routines: RoutineBody[] }>(`/api/bots/${bot.id}/routines`, { cookies });
    expect(gone.body.routines).toEqual([]);
  });

  test("BOTS=off stops routines from firing until the switch flips back", async () => {
    const { cookies, orgId } = await createOrgSession("bot-routines-off");
    const bot = await createBot(cookies, "Sentry");
    const created = await json<{ routine: RoutineBody }>(`/api/bots/${bot.id}/routines`, {
      method: "POST",
      cookies,
      body: { name: "Every minute", cron: "* * * * *", prompt: "Check the queue." },
    });
    expect(created.status).toBe(201);
    const record = (await listEnabledSchedules()).find((s) => s.id === created.body.routine.id);
    expect(record).toBeTruthy();

    process.env.BOTS = "off";
    try {
      await tick(new Date());
      const whileOff = await db.select({ id: runs.id }).from(runs).where(eq(runs.orgId, orgId));
      expect(whileOff).toEqual([]);
      await expect(fireScheduleForOrg(record!, "manual")).rejects.toMatchObject({
        status: 409,
        body: { error: "bots_disabled" },
      });
    } finally {
      process.env.BOTS = "1";
    }

    await tick(new Date());
    const afterOn = await db.select({ threadId: runs.threadId }).from(runs).where(eq(runs.orgId, orgId));
    expect(afterOn).toHaveLength(1);
    const after = await json<{ bot: BotBody }>(`/api/bots/${bot.id}`, { cookies });
    expect(after.body.bot.homeThreadId).toBe(afterOn[0]?.threadId ?? null);
  });

  test("routines are scoped to their bot and validated like automations", async () => {
    const { cookies } = await createOrgSession("bot-routines-scope");
    const a = await createBot(cookies, "Atlas");
    const b = await createBot(cookies, "Nova");
    const created = await json<{ routine: RoutineBody }>(`/api/bots/${a.id}/routines`, {
      method: "POST",
      cookies,
      body: { name: "Nightly audit", cron: "0 2 * * *", prompt: "Audit dependencies." },
    });
    expect(created.status).toBe(201);
    const crossBot = await fetchApi(`/api/bots/${b.id}/routines/${created.body.routine.id}/run-now`, { method: "POST", cookies });
    expect(crossBot.status).toBe(404);
    const badCron = await fetchApi(`/api/bots/${a.id}/routines`, { method: "POST", cookies, body: { name: "x", cron: "not cron", prompt: "y" } });
    expect(badCron.status).toBe(400);
  });

  test("a retry recovers the winning home-thread follow-up after a first-fire race", async () => {
    const { cookies, orgId } = await createOrgSession("bot-routine-retarget-recovery");
    const bot = await createBot(cookies, "Relay");
    const opened = await json<{ id: string }>(`/api/bots/${bot.id}/messages`, {
      method: "POST",
      cookies,
      body: { text: "Open the durable home thread." },
    });
    expect(opened.status).toBe(201);
    await waitFor(async () => {
      const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, opened.body.id));
      return run?.status === "completed";
    });

    const created = await json<{ routine: RoutineBody }>(`/api/bots/${bot.id}/routines`, {
      method: "POST",
      cookies,
      body: { name: "Recover report", cron: "0 8 * * *", prompt: "Build the recovery report." },
    });
    expect(created.status).toBe(201);
    const schedule = await getScheduleForOrg(orgId, created.body.routine.id);
    if (!schedule) throw new Error("expected routine schedule");
    const occurrence = new Date("2026-09-02T08:00:00.000Z");
    const key = firingKey(schedule.id, "cron", occurrence);
    const target = await botFiringTarget(orgId, bot.id);
    if (!target?.head) throw new Error("expected bot home thread");

    // Recreate the durable state left by a crash after the losing root was
    // canceled and its retarget was accepted, but before firing record/pump.
    const strayId = crypto.randomUUID();
    const rootIntent: RunCommandIntent = {
      prompt: schedule.prompt,
      model: schedule.model,
      engine: schedule.engine,
      parentRunId: null,
      requestedRepos: schedule.repos,
      requestedResources: [],
      attachmentIds: [],
      memoryScope: target.bot.memoryScope,
      skillId: schedule.skillId,
      skillVersion: schedule.skillVersion,
      commandName: null,
      commandProvider: null,
      commandSessionId: null,
      commandCatalogRevision: null,
    };
    expect(await acceptUnattendedRunCommand({
      idempotencyKey: key,
      orgId,
      actorId: schedule.userId,
      origin: AUTOMATION_RUN_ORIGIN,
      acceptedModelPolicy: "persisted",
      intent: rootIntent,
      run: {
        id: strayId,
        prompt: schedule.prompt,
        model: schedule.model,
        engine: schedule.engine,
        parentRunId: null,
        threadId: strayId,
        repos: [],
        resolvedResources: [],
        memoryScope: target.bot.memoryScope,
        skillId: schedule.skillId,
        skillVersion: schedule.skillVersion,
        skillContentHash: schedule.skillContentHash,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    })).toMatchObject({ status: "created", runId: strayId });
    await acceptRunCancel({ orgId, actorId: null, runId: strayId });

    const retargetId = crypto.randomUUID();
    const followupIntent: RunCommandIntent = {
      ...rootIntent,
      prompt: schedule.prompt,
      parentRunId: target.head.id,
      requestedRepos: [],
      skillId: null,
      skillVersion: null,
    };
    expect(await acceptExistingThreadFollowup(orgId, target.head.id, {
      idempotencyKey: `${key}:retarget`,
      orgId,
      actorId: schedule.userId,
      acceptedModelPolicy: "persisted",
      intent: followupIntent,
      run: {
        id: retargetId,
        prompt: schedule.prompt,
        model: schedule.model,
        engine: schedule.engine,
        parentRunId: target.head.id,
        threadId: target.head.threadId,
        repos: [],
        resolvedResources: [],
        memoryScope: target.bot.memoryScope,
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    }, AUTOMATION_RUN_ORIGIN)).toMatchObject({ status: "created", runId: retargetId });

    const recovered = await fireScheduleWithOutcome(schedule, "cron", occurrence);
    expect(recovered).toEqual({ runId: retargetId, created: false, firingRecorded: true });
    await waitFor(async () => {
      const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, retargetId));
      return run?.status === "completed";
    });
    const history = await json<{ firings: { run_id: string }[] }>(
      `/api/bots/${bot.id}/routines/${schedule.id}/history`,
      { cookies },
    );
    expect(history.body.firings.map((f) => f.run_id)).toEqual([retargetId]);
  });

  test("approvals on a bot's home thread wait for a person instead of expiring in minutes", async () => {
    const { cookies, orgId } = await createOrgSession("bot-approvals");
    const bot = await createBot(cookies, "Scout");
    const first = await json<{ id: string }>(`/api/bots/${bot.id}/messages`, { method: "POST", cookies, body: { text: "Draft the openers." } });
    expect(first.status).toBe(201);
    const botRequest = await createApprovalRequest({
      orgId,
      runId: first.body.id,
      threadId: first.body.id,
      toolName: "send_email",
      arguments: { to: "someone@example.com" },
    });
    const botTtl = botRequest.request.expiresAt.getTime() - Date.now();
    expect(botTtl).toBeGreaterThan(BOT_REQUEST_TTL_MS - 60_000);

    const plain = await json<{ id: string }>("/api/runs", { method: "POST", cookies, body: { prompt: "Plain run.", engine: "mock" } });
    expect(plain.status).toBe(201);
    const plainRequest = await createApprovalRequest({
      orgId,
      runId: plain.body.id,
      threadId: plain.body.id,
      toolName: "send_email",
      arguments: { to: "someone@example.com" },
    });
    const plainTtl = plainRequest.request.expiresAt.getTime() - Date.now();
    expect(plainTtl).toBeLessThanOrEqual(APPROVAL_REQUEST_TTL_MS);
  });
});
