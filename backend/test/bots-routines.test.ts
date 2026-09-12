import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { APPROVAL_REQUEST_TTL_MS, BOT_REQUEST_TTL_MS, createApprovalRequest } from "../src/knowledge/gateway/approval-requests";
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
    const first = await json<{ runId: string }>(`/api/bots/${bot.id}/routines/${routineId}/run-now`, { method: "POST", cookies });
    expect(first.status).toBe(202);
    const afterFirst = await json<{ bot: BotBody }>(`/api/bots/${bot.id}`, { cookies });
    expect(afterFirst.body.bot.homeThreadId).toBe(first.body.runId);
    const rootRun = await json<{ prompt: string; parent_run_id: string | null }>(`/api/runs/${first.body.runId}`, { cookies });
    expect(rootRun.body.prompt.startsWith("Build the weekly metrics workbook.")).toBe(true);
    expect(rootRun.body.prompt).toContain("Numbers come from the warehouse.");

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
