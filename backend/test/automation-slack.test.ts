/**
 * Automation Slack actions — notifications.slack (posted when a firing is
 * accepted) and delivery.slack (the fired run's terminal summary), both
 * executed through the durable Slack outbox. Also covers the enable gate: a
 * recognized tenant-qualified Slack target may be enabled, unrecognized
 * shapes stay refused, and SLACK_CHANNEL_ALLOWLIST is respected.
 *
 * Zero live Slack: outbound calls are recorded via setSlackClientForTest.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fireScheduleWithOutcome, firingKey } from "../src/schedules/fire";
import { getScheduleForOrg, type ApiSchedule } from "../src/schedules/repo";
import { slackConfig } from "../src/env";
import { setSlackClientForTest } from "../src/slack";
import {
  getSlackOutbox,
  processDue,
  startSlackOutboxRelay,
  stopSlackOutboxRelay,
} from "../src/slack/outbox";
import { findSlackWorkspace, upsertSlackWorkspace } from "../src/slack/workspaces";
import { createOrgSession, json, uid, waitFor, type OrgSession } from "./helpers";

const messages: Array<{ channel: string; text: string; threadTs?: string }> = [];
const TEAM_ID = "T0AUTOMATION";

// Hermetic Slack env (same rationale as test/slack.test.ts): Bun auto-loads
// backend/.env, and a machine-level channel allowlist or engine selection
// would 403 this suite's synthetic channels or route runs to live engines.
const SLACK_ENV_OVERRIDES: Record<string, string | undefined> = {
  SLACK_SIGNING_SECRET: "test-signing-secret",
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_LEGACY_TEAM_ID: TEAM_ID,
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
  startSlackOutboxRelay(slackConfig()!);
});

afterAll(() => {
  setSlackClientForTest(null);
  for (const [k, saved] of Object.entries(savedSlackEnv)) {
    if (saved === undefined) delete process.env[k];
    else process.env[k] = saved;
  }
  const restored = slackConfig();
  if (restored) startSlackOutboxRelay(restored);
  else stopSlackOutboxRelay();
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

async function bindSlackWorkspace(s: OrgSession): Promise<void> {
  await upsertSlackWorkspace({
    teamId: TEAM_ID,
    orgId: s.orgId,
    userId: `automation-owner-${s.orgId}`,
  });
}

function slackTarget(channel: string): { slack: { teamId: string; channel: string } } {
  return { slack: { teamId: TEAM_ID, channel } };
}

describe("automation enable gate (slack targets)", () => {
  test("a recognized slack target may be enabled", async () => {
    const s = await createOrgSession("auto-slack-enable");
    await bindSlackWorkspace(s);
    const automation = await createAutomation(s, {
      notifications: slackTarget("C0AUTOGATE"),
      delivery: slackTarget("C0AUTOGATE"),
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
    await bindSlackWorkspace(s);
    const saved = process.env.SLACK_CHANNEL_ALLOWLIST;
    process.env.SLACK_CHANNEL_ALLOWLIST = "C0ALLOWED";
    try {
      const outside = await createAutomation(s, {
        notifications: slackTarget("C0FORBIDDEN"),
      });
      const refused = await json<{ error: string }>(`/api/automations/${outside.id}`, {
        method: "PATCH",
        body: { enabled: true },
        cookies: s.cookies,
      });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe("automation_delivery_not_ready");

      const inside = await createAutomation(s, {
        notifications: slackTarget("C0ALLOWED"),
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

  test("a legacy channel-only target qualifies through the org-owned legacy team", async () => {
    const s = await createOrgSession("auto-slack-unqualified");
    await bindSlackWorkspace(s);
    const automation = await createAutomation(s, {
      delivery: { slack: { channel: "C0UNQUALIFIED" } },
    });

    const enabled = await json<ApiSchedule>(`/api/automations/${automation.id}`, {
      method: "PATCH",
      body: { enabled: true },
      cookies: s.cookies,
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);
  });

  test("a Slack target without an executable bot credential cannot be enabled", async () => {
    const s = await createOrgSession("auto-slack-no-credential");
    await bindSlackWorkspace(s);
    const savedBot = process.env.SLACK_BOT_TOKEN;
    const savedTeam = process.env.SLACK_LEGACY_TEAM_ID;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_LEGACY_TEAM_ID;
    try {
      const automation = await createAutomation(s, {
        delivery: slackTarget("C0NOCREDENTIAL"),
      });
      const refused = await json<{ error: string }>(`/api/automations/${automation.id}`, {
        method: "PATCH",
        body: { enabled: true },
        cookies: s.cookies,
      });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe("automation_delivery_not_ready");
    } finally {
      if (savedBot === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = savedBot;
      if (savedTeam === undefined) delete process.env.SLACK_LEGACY_TEAM_ID;
      else process.env.SLACK_LEGACY_TEAM_ID = savedTeam;
    }
  });

  test("a workspace connected to another org cannot be selected", async () => {
    const owner = await createOrgSession("auto-slack-workspace-owner");
    const attacker = await createOrgSession("auto-slack-workspace-attacker");
    await bindSlackWorkspace(owner);
    const automation = await createAutomation(attacker, {
      delivery: slackTarget("C0CROSSORG"),
    });

    const refused = await json<{ error: string }>(`/api/automations/${automation.id}`, {
      method: "PATCH",
      body: { enabled: true },
      cookies: attacker.cookies,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("automation_delivery_not_ready");
  });
});

describe("automation firing -> durable slack outbox", () => {
  test("run-now with notifications.slack posts the fire notification", async () => {
    const s = await createOrgSession("auto-slack-notify");
    await bindSlackWorkspace(s);
    const channel = `C0N${uid("ch")}`;
    const name = `Notify proof ${uid("n")}`;
    const automation = await createAutomation(s, {
      name,
      notifications: slackTarget(channel),
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
    await bindSlackWorkspace(s);
    const channel = `C0D${uid("ch")}`;
    const name = `Delivery proof ${uid("d")}`;
    const automation = await createAutomation(s, {
      name,
      delivery: slackTarget(channel),
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
    expect(JSON.parse(row.payload)).toMatchObject({ teamId: TEAM_ID, channel });
  });

  test("a replayed occurrence enqueues the fire notification at most once", async () => {
    const s = await createOrgSession("auto-slack-replay");
    await bindSlackWorkspace(s);
    const channel = `C0R${uid("ch")}`;
    const automation = await createAutomation(s, {
      notifications: slackTarget(channel),
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
    await bindSlackWorkspace(s);
    const channel = `C0B${uid("ch")}`;
    const automation = await createAutomation(s, {
      notifications: slackTarget(channel),
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

  test("fire-time workspace revalidation blocks a schedule after the team changes org", async () => {
    const owner = await createOrgSession("auto-slack-rebound-owner");
    const replacement = await createOrgSession("auto-slack-rebound-replacement");
    await bindSlackWorkspace(owner);
    const channel = `C0X${uid("ch")}`;
    const automation = await createAutomation(owner, {
      notifications: slackTarget(channel),
    });
    const schedule = await getScheduleForOrg(owner.orgId, automation.id);
    expect(schedule).not.toBeNull();

    await bindSlackWorkspace(replacement);
    const occurrence = new Date();
    await fireScheduleWithOutcome(schedule!, "manual", occurrence);

    const key = `automation-notify:${firingKey(schedule!.id, "manual", occurrence)}`;
    expect(await getSlackOutbox(key)).toBeNull();
    expect(messages.filter((message) => message.channel === channel)).toHaveLength(0);
  });

  test("a workspace rebind after enqueue cannot switch the durable row to another org credential", async () => {
    stopSlackOutboxRelay();
    const owner = await createOrgSession("auto-slack-outbox-owner");
    const replacement = await createOrgSession("auto-slack-outbox-replacement");
    await bindSlackWorkspace(owner);
    const channel = `C0Q${uid("ch")}`;
    const automation = await createAutomation(owner, {
      notifications: slackTarget(channel),
    });
    const schedule = await getScheduleForOrg(owner.orgId, automation.id);
    const occurrence = new Date();
    await fireScheduleWithOutcome(schedule!, "manual", occurrence);
    const key = `automation-notify:${firingKey(schedule!.id, "manual", occurrence)}`;
    expect(await getSlackOutbox(key)).toMatchObject({ state: "pending" });

    await bindSlackWorkspace(replacement);
    const scopes: Array<{ teamId: string; orgId: string | null }> = [];
    await processDue(null, async (teamId, expectedOrgId) => {
      scopes.push({ teamId, orgId: expectedOrgId });
      const workspace = await findSlackWorkspace(teamId);
      if (workspace?.orgId === expectedOrgId) {
        throw new Error("workspace unexpectedly retained the enqueue-time org");
      }
      return null;
    });

    expect(scopes).toContainEqual({ teamId: TEAM_ID, orgId: owner.orgId });
    expect(await getSlackOutbox(key)).toMatchObject({
      state: "dead",
      lastError: "integration_not_connected",
    });
    expect(messages.filter((message) => message.channel === channel)).toHaveLength(0);
  });
});
