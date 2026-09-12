import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  handoffToBot,
  MAX_UNATTENDED_HANDOFFS_PER_BOT_PER_HOUR,
  retryHandoffHeadRace,
  resolveBotMention,
} from "../src/bots/handoffs";
import { BOT_REQUEST_TTL_MS, createApprovalRequest } from "../src/knowledge/gateway/approval-requests";
import { executeRegisteredGatewayTool } from "../src/knowledge/gateway/operation-registry";
import { describeBot, getBotRow, rowToInput, setBotHomeThread, updateBotRow } from "../src/bots/repo";
import { approveApprovalRequest } from "../src/knowledge/gateway/approval-requests";
import { setRunStatus } from "../src/runs/repo";
import { db } from "../src/db/client";
import { botHandoffs, bots, commands, runs, threadRelationships } from "../src/db/schema";
import { AUTOMATION_RUN_ORIGIN, BOT_HANDOFF_RUN_ORIGIN } from "../src/runs/origin";
import { createOrgSession, fetchApi, json } from "./helpers";

const previousFlag = process.env.BOTS;
const previousChildThreads = process.env.PRODUCT_CHILD_THREADS;
const previousRelationshipRead = process.env.THREAD_RELATIONSHIPS_READ;
beforeAll(() => {
  process.env.BOTS = "1";
  // Handoffs are product child threads; without the v0.0.4 flag they are refused.
  process.env.PRODUCT_CHILD_THREADS = "on";
  process.env.THREAD_RELATIONSHIPS_READ = "read";
});
afterAll(() => {
  if (previousFlag === undefined) delete process.env.BOTS;
  else process.env.BOTS = previousFlag;
  if (previousChildThreads === undefined) delete process.env.PRODUCT_CHILD_THREADS;
  else process.env.PRODUCT_CHILD_THREADS = previousChildThreads;
  if (previousRelationshipRead === undefined) delete process.env.THREAD_RELATIONSHIPS_READ;
  else process.env.THREAD_RELATIONSHIPS_READ = previousRelationshipRead;
});

interface BotBody {
  id: string;
  name: string;
  engine: string;
  state: string;
  handoffs: number;
}
interface RunCreated {
  id: string;
  status: string;
  handoffs?: { botId: string; name: string; threadId: string | null; status: string; reason?: string }[];
}

async function createBot(cookies: string, name: string, engine: string): Promise<BotBody> {
  const created = await json<{ bot: BotBody }>("/api/bots", {
    method: "POST",
    cookies,
    body: { name, title: "Research analyst", rules: "Cite every claim.", engine },
  });
  expect(created.status).toBe(201);
  return created.body.bot;
}

async function ensureRootRelationship(orgId: string, threadId: string, title: string): Promise<void> {
  await db.insert(threadRelationships).values({
    orgId,
    threadId,
    parentThreadId: null,
    familyThreadId: threadId,
    kind: "root",
    title,
    sourceRunId: threadId,
  }).onConflictDoNothing();
}

describe("bot handoffs (@mentions)", () => {
  test("a bot whose name has a space is mentioned by its handle and titled by its name once", async () => {
    const { cookies, orgId } = await createOrgSession("bot-handoff-handle");
    const triage = await createBot(cookies, "Night triage", "mock");
    const parent = await json<RunCreated>("/api/runs", {
      method: "POST",
      cookies,
      body: { prompt: "@bot/night-triage look at the overnight alerts.", engine: "mock", bot_mentions: [triage.id] },
    });
    expect(parent.status).toBe(201);
    expect(parent.body.handoffs?.[0]?.status).toBe("created");
    const childThreadId = parent.body.handoffs![0]!.threadId!;
    const [relationship] = await db
      .select({ title: threadRelationships.title })
      .from(threadRelationships)
      .where(and(eq(threadRelationships.orgId, orgId), eq(threadRelationships.threadId, childThreadId)));
    expect(relationship?.title).toBe("Night triage: look at the overnight alerts.");
  });

  test("retries four moving thread heads with bounded backoff before accepting", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const outcome = await retryHandoffHeadRace(
      async () => (++attempts < 5 ? { status: "stale_parent" } : { status: "created" }),
      async (milliseconds) => { delays.push(milliseconds); },
    );
    expect(outcome.status).toBe("created");
    expect(attempts).toBe(5);
    expect(delays).toEqual([25, 50, 100, 200]);
  });

  test("@mentioning a bot opens a delegated child thread on the bot's own preset", async () => {
    const { cookies, orgId } = await createOrgSession("bot-handoffs");
    // The bot runs on a different engine than the parent turn: a cross-harness handoff.
    const nova = await createBot(cookies, "Nova", "opencode");

    const parent = await json<RunCreated>("/api/runs", {
      method: "POST",
      cookies,
      body: { prompt: "@bot/Nova pull the EU pricing pages and compare them.", engine: "mock", bot_mentions: [nova.id] },
    });
    expect(parent.status).toBe(201);
    expect(parent.body.handoffs).toHaveLength(1);
    const handoff = parent.body.handoffs![0]!;
    expect(handoff.botId).toBe(nova.id);
    expect(handoff.status).toBe("created");
    expect(handoff.threadId).toBeTruthy();
    const childThreadId = handoff.threadId!;

    const [child] = await db
      .select({ engine: runs.engine, threadId: runs.threadId, parentRunId: runs.parentRunId, prompt: runs.prompt, memoryScope: runs.memoryScope })
      .from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.id, childThreadId)));
    expect(child?.engine).toBe("opencode");
    expect(child?.threadId).toBe(childThreadId);
    // The delegated prompt is the message as typed; identity and rules are turn context.
    expect(child?.prompt).toBe("@bot/Nova pull the EU pricing pages and compare them.");

    const [relationship] = await db
      .select({ kind: threadRelationships.kind, title: threadRelationships.title, parentThreadId: threadRelationships.parentThreadId, familyThreadId: threadRelationships.familyThreadId })
      .from(threadRelationships)
      .where(and(eq(threadRelationships.orgId, orgId), eq(threadRelationships.threadId, childThreadId)));
    expect(relationship?.kind).toBe("delegated");
    // The delegated title names the bot once, not again through its own token.
    expect(relationship?.title).toBe("Nova: pull the EU pricing pages and compare them.");
    expect(relationship?.parentThreadId).toBe(parent.body.id);
    expect(relationship?.familyThreadId).toBe(parent.body.id);

    const [attribution] = await db
      .select({ botId: botHandoffs.botId, parentThreadId: botHandoffs.parentThreadId })
      .from(botHandoffs)
      .where(and(eq(botHandoffs.orgId, orgId), eq(botHandoffs.threadId, childThreadId)));
    expect(attribution?.botId).toBe(nova.id);
    expect(attribution?.parentThreadId).toBe(parent.body.id);

    const view = await json<{ bot: BotBody & { handoffThreadIds: string[] } }>(`/api/bots/${nova.id}`, { cookies });
    expect(view.body.bot.handoffs).toBe(1);
    expect(view.body.bot.handoffThreadIds).toEqual([childThreadId]);

    // Same message again with the same parent run is idempotent per (run, bot):
    // a follow-up in the parent thread that mentions Nova again opens a second handoff.
    const followup = await json<RunCreated>("/api/runs", {
      method: "POST",
      cookies,
      body: { prompt: "@bot/Nova also check the UK tier.", parent_run_id: parent.body.id, bot_mentions: [nova.id] },
    });
    expect(followup.status).toBe(201);
    // A later mention from the same thread continues the bot's existing delegated
    // thread instead of opening a second one: one conversation per bot per thread.
    expect(followup.body.handoffs?.[0]?.status).toBe("followed_up");
    expect(followup.body.handoffs?.[0]?.threadId).toBe(childThreadId);
    const childRuns = await db.select({ id: runs.id, prompt: runs.prompt }).from(runs).where(and(eq(runs.orgId, orgId), eq(runs.threadId, childThreadId)));
    expect(childRuns.length).toBe(2);
    expect(childRuns.map((r) => r.prompt)).toContain("@bot/Nova also check the UK tier.");
    const again = await json<{ bot: BotBody }>(`/api/bots/${nova.id}`, { cookies });
    expect(again.body.bot.handoffs).toBe(1);

    // The family view names the bot and the parent runs that followed up into
    // its thread, so a reloaded parent page can still show both receipts.
    const children = await json<{
      children: { thread_id: string; bot: { id: string; name: string } | null; follow_up_run_ids: string[] }[];
    }>(`/api/threads/${parent.body.id}/children`, { cookies });
    expect(children.status).toBe(200);
    const delegated = children.body.children.find((child) => child.thread_id === childThreadId);
    expect(delegated?.bot).toEqual({ id: nova.id, name: "Nova" });
    expect(delegated?.follow_up_run_ids).toEqual([followup.body.id]);

    // The org-wide index (sidebar, palette) lists the child too: its family anchor is
    // the user's own root thread, so the bot-handoff origin on its run does not hide it.
    const index = await json<{ relationships: { thread_id: string; parent_thread_id: string | null }[] }>(
      "/api/threads/relationships?limit=50",
      { cookies },
    );
    expect(index.status).toBe(200);
    expect(index.body.relationships.find((item) => item.thread_id === childThreadId)?.parent_thread_id).toBe(parent.body.id);
  });

  test("mentions are validated, unknown bots are reported, and the flag gates the field", async () => {
    const { cookies, orgId } = await createOrgSession("bot-handoffs-invalid");
    const bad = await fetchApi("/api/runs", { method: "POST", cookies, body: { prompt: "x", engine: "mock", bot_mentions: ["nope"] } });
    expect(bad.status).toBe(400);
    const unknown = await json<RunCreated>("/api/runs", {
      method: "POST",
      cookies,
      body: { prompt: "x", engine: "mock", bot_mentions: ["00000000-0000-4000-8000-000000000000"] },
    });
    expect(unknown.status).toBe(201);
    expect(unknown.body.handoffs?.[0]?.status).toBe("not_found");

    const atlas = await createBot(cookies, "Atlas", "mock");
    expect(await resolveBotMention(orgId, "atlas")).toMatchObject({ id: atlas.id });
    expect(await resolveBotMention(orgId, "@bot/ATLAS")).toMatchObject({ id: atlas.id });
    expect(await resolveBotMention(orgId, atlas.id)).toMatchObject({ id: atlas.id });
    expect(await resolveBotMention(orgId, "nobody")).toBeNull();
    // A name with spaces is one token through its handle, and still resolves by name.
    const triage = await createBot(cookies, "Night triage", "mock");
    expect(await resolveBotMention(orgId, "@bot/night-triage")).toMatchObject({ id: triage.id });
    expect(await resolveBotMention(orgId, "Night Triage")).toMatchObject({ id: triage.id });
    expect(await resolveBotMention(orgId, "night")).toBeNull();

    process.env.BOTS = "off";
    try {
      const gated = await fetchApi("/api/runs", { method: "POST", cookies, body: { prompt: "x", engine: "mock", bot_mentions: [atlas.id] } });
      expect(gated.status).toBe(404);
    } finally {
      process.env.BOTS = "1";
    }
    // Bots on but product child threads off: the run starts, the handoff is refused honestly.
    process.env.PRODUCT_CHILD_THREADS = "off";
    try {
      const degraded = await json<RunCreated>("/api/runs", { method: "POST", cookies, body: { prompt: "x", engine: "mock", bot_mentions: [atlas.id] } });
      expect(degraded.status).toBe(201);
      expect(degraded.body.handoffs?.[0]?.status).toBe("unavailable");
    } finally {
      process.env.PRODUCT_CHILD_THREADS = "on";
    }
  });

  test("concurrent first handoffs converge on one thread and exact retries do not add a turn", async () => {
    const { cookies, orgId } = await createOrgSession("bot-handoffs-race");
    const createdBot = await createBot(cookies, "Relay", "mock");
    const [bot] = await db.select().from(bots).where(eq(bots.id, createdBot.id)).limit(1);
    expect(bot).toBeTruthy();
    const parent = await json<RunCreated>("/api/runs", {
      method: "POST",
      cookies,
      body: { prompt: "Coordinate Relay.", engine: "mock" },
    });
    expect(parent.status).toBe(201);

    const requests = [
      { text: "First concurrent task", idempotencyKey: "race-a" },
      { text: "Second concurrent task", idempotencyKey: "race-b" },
    ].map((request) => ({
      orgId,
      actorId: null,
      parentRunId: parent.body.id,
      threadId: parent.body.id,
      bot: bot!,
      ...request,
    }));
    const outcomes = await Promise.all(requests.map(handoffToBot));
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["created", "followed_up"]);
    expect(new Set(outcomes.map((outcome) => outcome.threadId)).size).toBe(1);
    expect(await db.select().from(botHandoffs).where(and(
      eq(botHandoffs.orgId, orgId),
      eq(botHandoffs.botId, createdBot.id),
      eq(botHandoffs.parentThreadId, parent.body.id),
    ))).toHaveLength(1);

    const createdIndex = outcomes.findIndex((outcome) => outcome.status === "created");
    const childThreadId = outcomes[createdIndex]!.threadId!;
    const beforeRetry = await db.select().from(runs).where(and(eq(runs.orgId, orgId), eq(runs.threadId, childThreadId)));
    const retry = await handoffToBot(requests[createdIndex]!);
    expect(retry).toMatchObject({ status: "replayed", threadId: childThreadId });
    const afterRetry = await db.select().from(runs).where(and(eq(runs.orgId, orgId), eq(runs.threadId, childThreadId)));
    expect(afterRetry).toHaveLength(beforeRetry.length);
  });

  test("the same caller idempotency key is independent across parent threads", async () => {
    const { cookies, orgId } = await createOrgSession("bot-handoffs-parent-scope");
    const createdBot = await createBot(cookies, "Scope", "mock");
    const [bot] = await db.select().from(bots).where(eq(bots.id, createdBot.id)).limit(1);
    const parents = await Promise.all(["Parent one", "Parent two"].map((prompt) => json<RunCreated>("/api/runs", {
      method: "POST",
      cookies,
      body: { prompt, engine: "mock" },
    })));

    const initial = await Promise.all(parents.map((parent, index) => handoffToBot({
      orgId,
      actorId: null,
      parentRunId: parent.body.id,
      threadId: parent.body.id,
      bot: bot!,
      text: `Initial scoped task ${index}`,
      idempotencyKey: `initial-${index}`,
    })));
    expect(initial.map((outcome) => outcome.status)).toEqual(["created", "created"]);

    const outcomes = await Promise.all(parents.map((parent, index) => handoffToBot({
      orgId,
      actorId: null,
      parentRunId: parent.body.id,
      threadId: parent.body.id,
      bot: bot!,
      text: `Follow-up scoped task ${index}`,
      idempotencyKey: "same-raw-caller-key",
    })));
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["followed_up", "followed_up"]);
    expect(outcomes.map((outcome) => outcome.threadId)).toEqual(initial.map((outcome) => outcome.threadId));
  });

  test("the bot-global unattended cap is atomic across parent threads and ignores creator user ids", async () => {
    const { cookies, orgId, userId } = await createOrgSession("bot-handoffs-global-cap");
    const createdBot = await createBot(cookies, "Throttle", "mock");
    const [bot] = await db.select().from(bots).where(eq(bots.id, createdBot.id)).limit(1);
    if (!bot) throw new Error("no bot");
    const seededSource = crypto.randomUUID();
    await db.insert(runs).values({
      id: seededSource,
      orgId,
      userId,
      threadId: seededSource,
      status: "completed",
      prompt: "scheduled source",
      model: "mock-model",
      engine: "mock",
      memoryScope: "org",
      origin: AUTOMATION_RUN_ORIGIN,
    });
    for (let index = 0; index < MAX_UNATTENDED_HANDOFFS_PER_BOT_PER_HOUR - 1; index += 1) {
      const childId = crypto.randomUUID();
      await db.insert(runs).values({
        id: childId,
        orgId,
        userId,
        threadId: childId,
        status: "completed",
        prompt: `seed ${index}`,
        model: "mock-model",
        engine: "mock",
        memoryScope: "org",
        origin: BOT_HANDOFF_RUN_ORIGIN,
      });
      await db.insert(botHandoffs).values({
        orgId,
        botId: bot.id,
        threadId: childId,
        parentThreadId: `seed-parent-${index}`,
        sourceRunId: seededSource,
      });
    }
    const parents = await Promise.all(["race one", "race two"].map((prompt) => json<RunCreated>("/api/runs", {
      method: "POST",
      cookies,
      body: { prompt, engine: "mock" },
    })));
    await Promise.all(parents.map((parent, index) => ensureRootRelationship(orgId, parent.body.id, `race ${index}`)));
    await db.update(runs).set({ origin: AUTOMATION_RUN_ORIGIN }).where(inArray(runs.id, parents.map((parent) => parent.body.id)));
    const outcomes = await Promise.all(parents.map((parent, index) => handoffToBot({
      orgId,
      actorId: userId,
      parentRunId: parent.body.id,
      threadId: parent.body.id,
      bot,
      text: `unattended ${index}`,
      idempotencyKey: `unattended-${index}`,
    })));
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["created", "refused"]);
    expect(outcomes.find((outcome) => outcome.status === "refused")).toMatchObject({ reason: "cap" });

    const humanParent = await json<RunCreated>("/api/runs", {
      method: "POST",
      cookies,
      body: { prompt: "human source", engine: "mock" },
    });
    await ensureRootRelationship(orgId, humanParent.body.id, "human source");
    const human = await handoffToBot({
      orgId,
      actorId: userId,
      parentRunId: humanParent.body.id,
      threadId: humanParent.body.id,
      bot,
      text: "human ask",
      idempotencyKey: "human-ask",
    });
    expect(human.status).toBe("created");
    const [humanChild] = await db.select({ origin: runs.origin }).from(runs).where(eq(runs.id, human.threadId!));
    expect(humanChild?.origin).toBe(BOT_HANDOFF_RUN_ORIGIN);
  });

  test("one run can attempt only five distinct bots even when all delegated threads already exist", async () => {
    const { cookies, orgId, userId } = await createOrgSession("bot-handoff-reused-turn-cap");
    const createdBots = await Promise.all(Array.from({ length: 6 }, (_, index) => createBot(cookies, `Reuse${index}`, "mock")));
    const botRows = await db.select().from(bots).where(inArray(bots.id, createdBots.map((bot) => bot.id)));
    const byId = new Map(botRows.map((bot) => [bot.id, bot]));
    const parent = await json<RunCreated>("/api/runs", {
      method: "POST",
      cookies,
      body: { prompt: "parent", engine: "mock" },
    });
    await ensureRootRelationship(orgId, parent.body.id, "parent");
    for (const createdBot of createdBots) {
      const childId = crypto.randomUUID();
      await db.insert(runs).values({
        id: childId,
        orgId,
        userId,
        threadId: childId,
        status: "completed",
        prompt: "existing child",
        model: "mock-model",
        engine: "mock",
        memoryScope: "org",
        origin: BOT_HANDOFF_RUN_ORIGIN,
      });
      await db.insert(threadRelationships).values({
        orgId,
        threadId: childId,
        parentThreadId: parent.body.id,
        familyThreadId: parent.body.id,
        kind: "delegated",
        title: createdBot.name,
        sourceRunId: parent.body.id,
      });
      await db.insert(botHandoffs).values({
        orgId,
        botId: createdBot.id,
        threadId: childId,
        parentThreadId: parent.body.id,
        sourceRunId: parent.body.id,
      });
    }
    const sourceRun = crypto.randomUUID();
    await db.insert(runs).values({
      id: sourceRun,
      orgId,
      userId,
      parentRunId: parent.body.id,
      threadId: parent.body.id,
      status: "running",
      prompt: "one later turn",
      model: "mock-model",
      engine: "mock",
      memoryScope: "org",
    });
    const outcomes = [];
    for (const [index, createdBot] of createdBots.entries()) {
      outcomes.push(await handoffToBot({
        orgId,
        actorId: userId,
        parentRunId: sourceRun,
        threadId: parent.body.id,
        bot: byId.get(createdBot.id)!,
        text: `follow-up ${index}`,
        idempotencyKey: `reuse-${index}`,
      }));
    }
    expect(outcomes.slice(0, 5).every((outcome) => outcome.status === "followed_up")).toBe(true);
    expect(outcomes[5]).toMatchObject({ status: "refused", reason: "cap" });
    const attempts = await db.select().from(commands).where(and(
      eq(commands.orgId, orgId),
      eq(commands.kind, "bot.handoff.attempt"),
      eq(commands.runId, sourceRun),
    ));
    expect(attempts).toHaveLength(5);
    const retry = await handoffToBot({
      orgId,
      actorId: userId,
      parentRunId: sourceRun,
      threadId: parent.body.id,
      bot: byId.get(createdBots[0]!.id)!,
      text: "follow-up 0",
      idempotencyKey: "reuse-0",
    });
    expect(retry.status).toBe("replayed");
    expect(await db.select().from(commands).where(and(
      eq(commands.orgId, orgId),
      eq(commands.kind, "bot.handoff.attempt"),
      eq(commands.runId, sourceRun),
    ))).toHaveLength(5);
  });
});

describe("bot handoff guards", () => {
  const mention = (cookies: string, parentRunId: string, botId: string, text: string) =>
    json<RunCreated>("/api/runs", { method: "POST", cookies, body: { prompt: text, engine: "mock", parent_run_id: parentRunId, bot_mentions: [botId] } });

  test("a bot cannot hand work to itself, above its own chain, or below the depth cap", async () => {
    const { cookies } = await createOrgSession("bot-handoff-guards");
    const nova = await createBot(cookies, "Nova", "mock");
    const atlas = await createBot(cookies, "Atlas", "mock");
    const zed = await createBot(cookies, "Zed", "mock");

    // self: from Nova's own home thread
    const home = await json<{ id: string }>(`/api/bots/${nova.id}/messages`, { method: "POST", cookies, body: { text: "Start." } });
    expect(home.status).toBe(201);
    const selfHome = await mention(cookies, home.body.id, nova.id, "@bot/Nova do it yourself");
    expect(selfHome.body.handoffs?.[0]).toMatchObject({ status: "refused", reason: "self" });

    // depth 0 -> 1: a person's thread hands to Nova
    const root = await json<RunCreated>("/api/runs", { method: "POST", cookies, body: { prompt: "@bot/Nova compare the tiers.", engine: "mock", bot_mentions: [nova.id] } });
    const novaThread = root.body.handoffs?.[0]?.threadId;
    expect(root.body.handoffs?.[0]?.status).toBe("created");
    if (!novaThread) throw new Error("no nova thread");

    // self again: from inside Nova's delegated thread
    const selfChild = await mention(cookies, novaThread, nova.id, "@bot/Nova and again");
    expect(selfChild.body.handoffs?.[0]).toMatchObject({ status: "refused", reason: "self" });

    // depth 1 -> 2: Nova's thread hands to Atlas (allowed)
    const toAtlas = await mention(cookies, novaThread, atlas.id, "@bot/Atlas check the UK tier");
    expect(toAtlas.body.handoffs?.[0]?.status).toBe("created");
    const atlasThread = toAtlas.body.handoffs?.[0]?.threadId;
    if (!atlasThread) throw new Error("no atlas thread");

    // cycle: Atlas's thread (under Nova) hands back to Nova
    const backToNova = await mention(cookies, atlasThread, nova.id, "@bot/Nova your turn");
    expect(backToNova.body.handoffs?.[0]).toMatchObject({ status: "refused", reason: "cycle" });

    // depth: Atlas's thread is at depth 2, no further handoffs
    const tooDeep = await mention(cookies, atlasThread, zed.id, "@bot/Zed go deeper");
    expect(tooDeep.body.handoffs?.[0]).toMatchObject({ status: "refused", reason: "depth" });
  });

  test("retrying a handoff with the same key replays the child instead of appending a turn", async () => {
    const { cookies, orgId } = await createOrgSession("bot-handoff-replay");
    await createBot(cookies, "Nova", "mock");
    const bot = await resolveBotMention(orgId, "Nova");
    if (!bot) throw new Error("no bot");
    const parent = await json<RunCreated>("/api/runs", { method: "POST", cookies, body: { prompt: "Parent.", engine: "mock" } });
    const input = { orgId, actorId: null, parentRunId: parent.body.id, threadId: parent.body.id, bot, text: "Compare the tiers.", idempotencyKey: "tool-key-1" };
    const first = await handoffToBot(input);
    expect(first.status).toBe("created");
    const retry = await handoffToBot(input);
    expect(retry).toMatchObject({ status: "replayed", threadId: first.threadId });
    const childRuns = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.orgId, orgId), eq(runs.threadId, first.threadId!)));
    expect(childRuns).toHaveLength(1);
    // a NEW key from the same thread is a follow-up into the same child, not a second child
    const next = await handoffToBot({ ...input, idempotencyKey: "tool-key-2", text: "Also the UK tier." });
    expect(next).toMatchObject({ status: "followed_up", threadId: first.threadId });
  });

  test("approvals raised inside a handoff thread wait for a person and show on the bot's roster", async () => {
    const { cookies, orgId } = await createOrgSession("bot-handoff-approvals");
    const nova = await createBot(cookies, "Nova", "mock");
    const root = await json<RunCreated>("/api/runs", { method: "POST", cookies, body: { prompt: "@bot/Nova send the recap.", engine: "mock", bot_mentions: [nova.id] } });
    const childThread = root.body.handoffs?.[0]?.threadId;
    if (!childThread) throw new Error("no child thread");
    const request = await createApprovalRequest({ orgId, runId: childThread, threadId: childThread, toolName: "send_email", arguments: { to: "someone@example.com" } });
    expect(request.request.expiresAt.getTime() - Date.now()).toBeGreaterThan(BOT_REQUEST_TTL_MS - 60_000);
    const view = await json<{ bot: BotBody & { pendingApprovals: number; state: string } }>(`/api/bots/${nova.id}`, { cookies });
    expect(view.body.bot.pendingApprovals).toBe(1);
  });
});

describe("bot handoff through the gateway tool", () => {
  // The mock engine is dispatch-ready without a provider, so the child-session tools
  // (and bot_handoff with them) are enabled and execute locally.
  const claimsFor = (orgId: string, runId: string) => ({ orgId, userId: "", threadId: runId, runId, scope: "run" as const, exp: Date.now() + 60_000 });
  const text = (result: unknown) => JSON.stringify(result);
  // A live turn without a worker racing it: inserted directly, like the other gateway tests.
  const insertRunningRun = async (orgId: string) => {
    const id = crypto.randomUUID();
    await db.insert(runs).values({ id, orgId, userId: null, threadId: id, status: "running", prompt: "live turn", model: "mock-model", engine: "mock", memoryScope: "org" });
    return id;
  };

  test("a refusal is an error the agent can act on, never a success with a null thread", async () => {
    const { cookies, orgId } = await createOrgSession("bot-gateway-refusal");
    const nova = await createBot(cookies, "Nova", "mock");
    const home = await insertRunningRun(orgId);
    expect(await setBotHomeThread(orgId, nova.id, home)).toBe(true);
    const refused = await executeRegisteredGatewayTool(claimsFor(orgId, home), "bot_handoff", { bot: "Nova", prompt: "Do it again.", idempotencyKey: "self-1" });
    if (!refused.matched) throw new Error("bot_handoff is not registered");
    expect((refused.result as { isError?: boolean }).isError).toBe(true);
    expect(text(refused.result)).toContain("already belongs to Nova");
    expect(text(refused.result)).not.toContain("child session null");
  });

  test("a handoff from a person's running thread opens the bot's delegated thread, and a retry replays it", async () => {
    const { cookies, orgId } = await createOrgSession("bot-gateway-handoff");
    await createBot(cookies, "Nova", "mock");
    const run = await insertRunningRun(orgId);
    const args = { bot: "nova", prompt: "Compare the tiers.", idempotencyKey: "tool-1" };
    const first = await executeRegisteredGatewayTool(claimsFor(orgId, run), "bot_handoff", args);
    expect((first.result as { isError?: boolean }).isError).not.toBe(true);
    expect(text(first.result)).toContain("Handed off to Nova in child session");
    const retry = await executeRegisteredGatewayTool(claimsFor(orgId, run), "bot_handoff", args);
    expect(text(retry.result)).toContain("Replayed handoff to Nova");
    const childId = (first.result as { structuredContent?: { child?: { id?: string } } }).structuredContent?.child?.id;
    const childRuns = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.orgId, orgId), eq(runs.threadId, childId!)));
    expect(childRuns).toHaveLength(1);
  });
});

describe("bot handoff invariants from the audit", () => {
  test("a mention and a bot_handoff call in the same turn hand the bot the ask once", async () => {
    const { cookies, orgId } = await createOrgSession("bot-handoff-once-per-run");
    const nova = await createBot(cookies, "Nova", "mock");
    const parent = await json<RunCreated>("/api/runs", { method: "POST", cookies, body: { prompt: "@bot/Nova compare the tiers.", engine: "mock", bot_mentions: [nova.id] } });
    const childThread = parent.body.handoffs?.[0]?.threadId;
    if (!childThread) throw new Error("no child thread");
    const bot = await resolveBotMention(orgId, "Nova");
    if (!bot) throw new Error("no bot");
    // The same run now calls the tool with its own key: replay, no second turn for the bot.
    const viaTool = await handoffToBot({ orgId, actorId: null, parentRunId: parent.body.id, threadId: parent.body.id, bot, text: "compare the tiers", idempotencyKey: "tool-key-from-the-model" });
    expect(viaTool).toMatchObject({ status: "replayed", threadId: childThread });
    const childRuns = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.orgId, orgId), eq(runs.threadId, childThread)));
    expect(childRuns).toHaveLength(1);
  });

  test("a running home thread keeps the bot working even when a delegated thread settled later", async () => {
    const { cookies, orgId } = await createOrgSession("bot-state-live-home");
    const nova = await createBot(cookies, "Nova", "mock");
    const home = await json<{ id: string }>(`/api/bots/${nova.id}/messages`, { method: "POST", cookies, body: { text: "Start." } });
    const parent = await json<RunCreated>("/api/runs", { method: "POST", cookies, body: { prompt: "@bot/Nova one more.", engine: "mock", bot_mentions: [nova.id] } });
    const childThread = parent.body.handoffs?.[0]?.threadId;
    if (!childThread) throw new Error("no child thread");
    await setRunStatus(childThread, "completed");
    await setRunStatus(home.body.id, "running");
    const row = await getBotRow(orgId, nova.id);
    if (!row) throw new Error("no bot row");
    const view = await describeBot(orgId, row);
    expect(view.state).toBe("working");
  });

  test("an unattended bot run can be approved by an org member; another userless run cannot", async () => {
    const { cookies, orgId } = await createOrgSession("bot-approve-unattended");
    const nova = await createBot(cookies, "Nova", "mock");
    const insertRunning = async () => {
      const id = crypto.randomUUID();
      await db.insert(runs).values({ id, orgId, userId: null, threadId: id, status: "running", prompt: "unattended", model: "mock-model", engine: "mock", memoryScope: "org" });
      return id;
    };
    const botRun = await insertRunning();
    expect(await setBotHomeThread(orgId, nova.id, botRun)).toBe(true);
    const plainRun = await insertRunning();
    const botRequest = await createApprovalRequest({ orgId, runId: botRun, threadId: botRun, toolName: "send_email", arguments: { to: "a@example.com" } });
    const plainRequest = await createApprovalRequest({ orgId, runId: plainRun, threadId: plainRun, toolName: "send_email", arguments: { to: "a@example.com" } });
    const botOutcome = await approveApprovalRequest({ orgId, requestId: botRequest.request.id, approvedBy: "member-1" });
    expect(botOutcome.ok).toBe(true);
    const plainOutcome = await approveApprovalRequest({ orgId, requestId: plainRequest.request.id, approvedBy: "member-1" });
    expect(plainOutcome).toMatchObject({ ok: false, error: "run_user_mismatch" });
  });
});

describe("handoff replay survives a bot edit", () => {
  test("a same-key retry after the bot's rules changed replays the child instead of conflicting", async () => {
    const { cookies, orgId } = await createOrgSession("bot-handoff-replay-after-edit");
    const nova = await createBot(cookies, "Nova", "mock");
    const parent = await json<RunCreated>("/api/runs", { method: "POST", cookies, body: { prompt: "Parent.", engine: "mock" } });
    const bot = await resolveBotMention(orgId, "Nova");
    if (!bot) throw new Error("no bot");
    const input = { orgId, actorId: null, parentRunId: parent.body.id, threadId: parent.body.id, bot, text: "Compare the tiers.", idempotencyKey: "edit-key" };
    const first = await handoffToBot(input);
    expect(first.status).toBe("created");
    // The bot's rules change between the first call and the retry; the retry must still replay.
    const edited = await updateBotRow(orgId, nova.id, { ...rowToInput(bot), rules: "Always cite two sources." });
    expect(edited?.rules).toBe("Always cite two sources.");
    const after = await resolveBotMention(orgId, "Nova");
    const retry = await handoffToBot({ ...input, bot: after ?? bot });
    expect(retry).toMatchObject({ status: "replayed", threadId: first.threadId });
    const childRuns = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.orgId, orgId), eq(runs.threadId, first.threadId!)));
    expect(childRuns).toHaveLength(1);
  });
});
