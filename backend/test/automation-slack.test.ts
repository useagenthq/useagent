/**
 * Automation Slack actions — notifications.slack (posted when a firing is
 * accepted) and delivery.slack (the fired run's terminal summary), both
 * executed through the durable Slack outbox. Also covers the enable gate: a
 * recognized `{ slack: { channel } }` target may be enabled, unrecognized
 * shapes stay refused, and SLACK_CHANNEL_ALLOWLIST is respected.
 *
 * Zero live Slack: outbound calls are recorded via setSlackClientForTest.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fireScheduleWithOutcome, firingKey } from "../src/schedules/fire";
import { getScheduleForOrg, type ApiSchedule } from "../src/schedules/repo";
import { setSlackClientForTest } from "../src/slack";
import { getSlackOutbox } from "../src/slack/outbox";
import { createOrgSession, json, uid, waitFor, type OrgSession } from "./helpers";

const messages: Array<{ channel: string; text: string; threadTs?: string }> = [];

// Hermetic Slack env (same rationale as test/slack.test.ts): Bun auto-loads
// backend/.env, and a machine-level channel allowlist or engine selection
// would 403 this suite's synthetic channels or route runs to live engines.
const SLACK_ENV_OVERRIDES: Record<string, string | undefined> = {
  SLACK_SIGNING_SECRET: "test-signing-secret",
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_APP_TOKEN: undefined,
  SLACK_CHANNEL_ALLOWLIST: undefined,
  SLACK_DEFAULT_ORG_ID: undefined,
  SLACK_DEFAULT_USER_ID: undefined,
  SLACK_DEFAULT_ENGINE: undefined,
  SLACK_DEFAULT_MODEL: undefined,
};
const savedSlackEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(SLACK_ENV_OVERRIDES)) {
    savedSlackEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setSlackClientForTest({
    postMessage: async (m) => {
      messages.push(m);
      return { ok: true };
    },
    updateMessage: async () => ({ ok: true }),
    addReaction: async () => ({ ok: true }),
    setSessionStatus: async () => ({ ok: true }),
    setThreadStatus: async () => ({ ok: true }),
    startStream: async () => ({ ok: true, ts: "stream.1" }),
    appendStream: async () => ({ ok: true }),
    stopStream: async () => ({ ok: true }),
    uploadFile: async () => ({ ok: true }),
  });
});

afterAll(() => {
  setSlackClientForTest(null);
  for (const [k, saved] of Object.entries(savedSlackEnv)) {
    if (saved === undefined) delete process.env[k];
    else process.env[k] = saved;
  }
});

async function createAutomation(
  s: OrgSession,
  body: Record<string, unknown>,
): Promise<ApiSchedule> {
  const res = await json<ApiSchedule>("/api/automations", {
    method: "POST",
    body: {
      name: body.name ?? `Automation ${uid("a")}`,
      cron: "0 9 * * *",
      prompt: body.prompt ?? "produce the daily report",
      engine: "mock",
      ...body,
    },
    cookies: s.cookies,
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe("automation enable gate (slack targets)", () => {
  test("a recognized slack target may be enabled", async () => {
    const s = await createOrgSession("auto-slack-enable");
    const automation = await createAutomation(s, {
      notifications: { slack: { channel: "C0AUTOGATE" } },
      delivery: { slack: { channel: "C0AUTOGATE" } },
    });
    const enabled = await json<ApiSchedule>(`/api/automations/${automation.id}`, {
      method: "PATCH",
      body: { enabled: true },
      cookies: s.cookies,
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);
  });

  test("an unrecognized delivery shape still refuses to enable", async () => {
    const s = await createOrgSession("auto-slack-shape");
    const automation = await createAutomation(s, {
      delivery: { mode: "summary" },
    });
    const refused = await json<{ error: string }>(`/api/automations/${automation.id}`, {
      method: "PATCH",
      body: { enabled: true },
      cookies: s.cookies,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("automation_delivery_not_ready");
  });

  test("SLACK_CHANNEL_ALLOWLIST gates which channels may be enabled", async () => {
    const s = await createOrgSession("auto-slack-allow");
    const saved = process.env.SLACK_CHANNEL_ALLOWLIST;
    process.env.SLACK_CHANNEL_ALLOWLIST = "C0ALLOWED";
    try {
      const outside = await createAutomation(s, {
        notifications: { slack: { channel: "C0FORBIDDEN" } },
      });
      const refused = await json<{ error: string }>(`/api/automations/${outside.id}`, {
        method: "PATCH",
        body: { enabled: true },
        cookies: s.cookies,
      });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe("automation_delivery_not_ready");

      const inside = await createAutomation(s, {
        notifications: { slack: { channel: "C0ALLOWED" } },
      });
      const enabled = await json<ApiSchedule>(`/api/automations/${inside.id}`, {
        method: "PATCH",
        body: { enabled: true },
        cookies: s.cookies,
      });
      expect(enabled.status).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.SLACK_CHANNEL_ALLOWLIST;
      else process.env.SLACK_CHANNEL_ALLOWLIST = saved;
    }
  });
});

describe("automation firing -> durable slack outbox", () => {
  test("run-now with notifications.slack posts the fire notification", async () => {
    const s = await createOrgSession("auto-slack-notify");
    const channel = `C0N${uid("ch")}`;
    const name = `Notify proof ${uid("n")}`;
    const automation = await createAutomation(s, {
      name,
      notifications: { slack: { channel } },
    });

    const fired = await json<{ run_id: string }>(`/api/automations/${automation.id}/run-now`, {
      method: "POST",
      cookies: s.cookies,
    });
    expect(fired.status).toBe(201);

    const msg = await waitFor(async () => messages.find((m) => m.channel === channel) ?? null);
    expect(msg.text).toContain(name);
    expect(msg.text).toContain(fired.body.run_id);
  });

  test("delivery.slack posts the run's terminal summary to the channel", async () => {
    const s = await createOrgSession("auto-slack-deliver");
    const channel = `C0D${uid("ch")}`;
    const name = `Delivery proof ${uid("d")}`;
    const automation = await createAutomation(s, {
      name,
      delivery: { slack: { channel } },
    });

    const fired = await json<{ run_id: string }>(`/api/automations/${automation.id}/run-now`, {
      method: "POST",
      cookies: s.cookies,
    });
    expect(fired.status).toBe(201);
    const runId = fired.body.run_id;

    // The run completes (mock engine), the finalize transaction enqueues the
    // delivery, and the relay posts it.
    const run = await waitFor(async () => {
      const { body } = await json<any>(`/api/runs/${runId}`, { cookies: s.cookies });
      return body?.status === "completed" ? body : null;
    });
    const msg = await waitFor(async () => messages.find((m) => m.channel === channel) ?? null);
    expect(msg.text).toContain(name);
    expect(msg.text).toContain(run.summary);

    // The durable row is keyed per run — delivered exactly once.
    const row = await waitFor(async () => getSlackOutbox(`automation-delivery:${runId}`));
    await waitFor(async () => {
      const latest = await getSlackOutbox(`automation-delivery:${runId}`);
      return latest?.state === "delivered" ? latest : null;
    });
    expect(row.kind).toBe("post_message");
  });

  test("a replayed occurrence enqueues the fire notification at most once", async () => {
    const s = await createOrgSession("auto-slack-replay");
    const channel = `C0R${uid("ch")}`;
    const automation = await createAutomation(s, {
      notifications: { slack: { channel } },
    });
    const schedule = await getScheduleForOrg(s.orgId, automation.id);
    expect(schedule).not.toBeNull();

    // The SAME manual occurrence fired twice (a crash retry) resolves to the
    // original run and must not enqueue a second notification.
    const occurrence = new Date();
    const first = await fireScheduleWithOutcome(schedule!, "manual", occurrence);
    const second = await fireScheduleWithOutcome(schedule!, "manual", occurrence);
    expect(second.runId).toBe(first.runId);

    const key = `automation-notify:${firingKey(schedule!.id, "manual", occurrence)}`;
    const row = await waitFor(async () => getSlackOutbox(key));
    expect(row.kind).toBe("post_message");
    await waitFor(async () => messages.some((m) => m.channel === channel) || null);
    await new Promise((r) => setTimeout(r, 150));
    expect(messages.filter((m) => m.channel === channel)).toHaveLength(1);
  });

  test("a channel outside SLACK_CHANNEL_ALLOWLIST never enqueues", async () => {
    const s = await createOrgSession("auto-slack-blocked");
    const channel = `C0B${uid("ch")}`;
    const automation = await createAutomation(s, {
      notifications: { slack: { channel } },
    });
    const schedule = await getScheduleForOrg(s.orgId, automation.id);

    const saved = process.env.SLACK_CHANNEL_ALLOWLIST;
    process.env.SLACK_CHANNEL_ALLOWLIST = "C0SOMEWHERE-ELSE";
    const occurrence = new Date();
    try {
      await fireScheduleWithOutcome(schedule!, "manual", occurrence);
    } finally {
      if (saved === undefined) delete process.env.SLACK_CHANNEL_ALLOWLIST;
      else process.env.SLACK_CHANNEL_ALLOWLIST = saved;
    }

    const key = `automation-notify:${firingKey(schedule!.id, "manual", occurrence)}`;
    expect(await getSlackOutbox(key)).toBeNull();
    await new Promise((r) => setTimeout(r, 150));
    expect(messages.filter((m) => m.channel === channel)).toHaveLength(0);
  });
});
