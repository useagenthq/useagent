import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  state: string;
  homeThreadId: string | null;
  lastAt: string | null;
}

describe("bots", () => {
  test("a bot is a preset over one home thread created by its first message", async () => {
    const { cookies } = await createOrgSession("bots");

    const created = await json<{ bot: BotBody }>("/api/bots", {
      method: "POST",
      cookies,
      body: {
        name: "Atlas",
        title: "Code reviewer",
        rules: "Never merge without approval.",
        engine: "mock",
        avatarTone: "violet",
        avatarIcon: "code",
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.bot.name).toBe("Atlas");
    expect(created.body.bot.state).toBe("idle");
    expect(created.body.bot.homeThreadId).toBeNull();
    const botId = created.body.bot.id;

    const duplicate = await fetchApi("/api/bots", { method: "POST", cookies, body: { name: "Atlas", engine: "mock" } });
    expect(duplicate.status).toBe(409);

    const first = await json<{ id: string }>(`/api/bots/${botId}/messages`, {
      method: "POST",
      cookies,
      body: { text: "Review the payments PR." },
    });
    expect(first.status).toBe(201);
    const rootRunId = first.body.id;

    const detail = await json<{ bot: BotBody }>(`/api/bots/${botId}`, { cookies });
    expect(detail.status).toBe(200);
    expect(detail.body.bot.homeThreadId).toBe(rootRunId);

    const second = await json<{ id: string }>(`/api/bots/${botId}/messages`, {
      method: "POST",
      cookies,
      body: { text: "Now fix the changelog." },
    });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(rootRunId);

    const thread = await json<{ thread?: unknown[] } | unknown[]>(`/api/runs/${rootRunId}?thread=1`, { cookies });
    expect(thread.status).toBe(200);
    const turns = Array.isArray(thread.body) ? thread.body : (thread.body.thread ?? []);
    expect(turns.length).toBeGreaterThanOrEqual(2);

    const rootRun = await json<{ prompt: string }>(`/api/runs/${rootRunId}`, { cookies });
    expect(rootRun.body.prompt).toContain("You are Atlas, Code reviewer.");
    expect(rootRun.body.prompt).toContain("Never merge without approval.");
    expect(rootRun.body.prompt).toContain("Review the payments PR.");

    const list = await json<{ bots: BotBody[] }>("/api/bots", { cookies });
    expect(list.body.bots.map((bot) => bot.name)).toEqual(["Atlas"]);

    const patched = await json<{ bot: BotBody }>(`/api/bots/${botId}`, {
      method: "PATCH",
      cookies,
      body: { title: "Payments reviewer" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.title).toBe("Payments reviewer");
    expect(patched.body.bot.rules).toBe("Never merge without approval.");
    expect(patched.body.bot.name).toBe("Atlas");
  });

  test("validation rejects unknown engines and oversized names", async () => {
    const { cookies } = await createOrgSession("bots-invalid");
    const badEngine = await fetchApi("/api/bots", { method: "POST", cookies, body: { name: "Nova", engine: "not-an-engine" } });
    expect(badEngine.status).toBe(400);
    const longName = await fetchApi("/api/bots", { method: "POST", cookies, body: { name: "x".repeat(61), engine: "mock" } });
    expect(longName.status).toBe(400);
  });

  test("the surface is dark unless BOTS is on for the org", async () => {
    const session = await createOrgSession("bots-dark");
    process.env.BOTS = "";
    try {
      const hidden = await fetchApi("/api/bots", { cookies: session.cookies });
      expect(hidden.status).toBe(404);
      process.env.BOTS_ORG_IDS = session.orgId;
      const allowlisted = await fetchApi("/api/bots", { cookies: session.cookies });
      expect(allowlisted.status).toBe(200);
    } finally {
      delete process.env.BOTS_ORG_IDS;
      process.env.BOTS = "1";
    }
  });
});
