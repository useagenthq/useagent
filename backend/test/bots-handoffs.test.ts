import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { resolveBotMention } from "../src/bots/handoffs";
import { db } from "../src/db/client";
import { botHandoffs, runs, threadRelationships } from "../src/db/schema";
import { createOrgSession, fetchApi, json } from "./helpers";

const previousFlag = process.env.BOTS;
const previousChildThreads = process.env.PRODUCT_CHILD_THREADS;
beforeAll(() => {
  process.env.BOTS = "1";
  // Handoffs are product child threads; without the v0.0.4 flag they are refused.
  process.env.PRODUCT_CHILD_THREADS = "on";
});
afterAll(() => {
  if (previousFlag === undefined) delete process.env.BOTS;
  else process.env.BOTS = previousFlag;
  if (previousChildThreads === undefined) delete process.env.PRODUCT_CHILD_THREADS;
  else process.env.PRODUCT_CHILD_THREADS = previousChildThreads;
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
  handoffs?: { botId: string; name: string; threadId: string | null; status: string }[];
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

describe("bot handoffs (@mentions)", () => {
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
    expect(child?.prompt.startsWith("@bot/Nova pull the EU pricing pages")).toBe(true);
    expect(child?.prompt).toContain("You are Nova, Research analyst.");
    expect(child?.prompt).toContain("Cite every claim.");

    const [relationship] = await db
      .select({ kind: threadRelationships.kind, parentThreadId: threadRelationships.parentThreadId, familyThreadId: threadRelationships.familyThreadId })
      .from(threadRelationships)
      .where(and(eq(threadRelationships.orgId, orgId), eq(threadRelationships.threadId, childThreadId)));
    expect(relationship?.kind).toBe("delegated");
    expect(relationship?.parentThreadId).toBe(parent.body.id);
    expect(relationship?.familyThreadId).toBe(parent.body.id);

    const [attribution] = await db
      .select({ botId: botHandoffs.botId, parentThreadId: botHandoffs.parentThreadId })
      .from(botHandoffs)
      .where(and(eq(botHandoffs.orgId, orgId), eq(botHandoffs.threadId, childThreadId)));
    expect(attribution?.botId).toBe(nova.id);
    expect(attribution?.parentThreadId).toBe(parent.body.id);

    const view = await json<{ bot: BotBody }>(`/api/bots/${nova.id}`, { cookies });
    expect(view.body.bot.handoffs).toBe(1);

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
    expect(childRuns.some((r) => r.prompt.includes("also check the UK tier") && r.prompt.includes("from the same thread as before"))).toBe(true);
    const again = await json<{ bot: BotBody }>(`/api/bots/${nova.id}`, { cookies });
    expect(again.body.bot.handoffs).toBe(1);
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

    process.env.BOTS = "";
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
});
