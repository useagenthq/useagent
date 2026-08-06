/**
 * Slack adapter tests — fully in-process, zero live Slack. Inbound events are
 * signed with the test signing secret (preload.ts) and posted to the mounted
 * route; outbound Slack calls are intercepted with setSlackClientForTest, so
 * addReaction/postMessage are recorded, never sent.
 *
 * Covers: signature verification (valid / bad / stale / missing), the
 * url_verification handshake, event dedupe, app_mention → root run, thread
 * reply → parent_run_id, thread-follow via the durable mapping, DM handling,
 * non-mention channel chatter ignored, the 👀 ack, and the completion post-back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { setSlackClientForTest } from "../src/slack";
import { dispatchSocketFrame } from "../src/slack/socket-mode";
import { fetchApi, json, uid, waitFor } from "./helpers";

const SECRET = "test-signing-secret"; // this suite signs every inbound event with it
const BOT = "U0BOTBOT";

// Hermetic Slack env. Bun auto-loads backend/.env, so the REAL SLACK_* creds
// leak into the test process and would override what this suite assumes: the
// real signing secret makes every signed event fail verification (401), and a
// real app token could open a live Socket Mode WS. Pin the values this suite
// depends on and restore whatever .env carried, so it is hermetic regardless of
// the machine's .env.
const SLACK_ENV_OVERRIDES: Record<string, string | undefined> = {
  SLACK_SIGNING_SECRET: SECRET,
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_APP_TOKEN: undefined, // keep a real app token out of the suite entirely
};
const savedSlackEnv: Record<string, string | undefined> = {};

interface Recorded {
  reactions: Array<{ channel: string; timestamp: string; name: string }>;
  messages: Array<{ channel: string; text: string; threadTs?: string }>;
  statuses: Array<{ channel: string; threadTs: string; status: string }>;
}
const rec: Recorded = { reactions: [], messages: [], statuses: [] };
/** When true the mock rejects setAssistantStatus — the non-assistant fallback case. */
let statusFails = false;

beforeAll(() => {
  for (const [k, v] of Object.entries(SLACK_ENV_OVERRIDES)) {
    savedSlackEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setSlackClientForTest({
    addReaction: async (a) => {
      rec.reactions.push(a);
      return { ok: true };
    },
    postMessage: async (m) => {
      rec.messages.push(m);
      return { ok: true };
    },
    setAssistantStatus: async (s) => {
      if (statusFails) throw new Error("invalid_thread (not an assistant container)");
      rec.statuses.push(s);
    },
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

function sign(timestamp: string, raw: string): string {
  return "v0=" + createHmac("sha256", SECRET).update(`v0:${timestamp}:${raw}`).digest("hex");
}

async function postSlack(
  envelope: unknown,
  opts: { timestamp?: string; signature?: string } = {},
): Promise<Response> {
  const raw = JSON.stringify(envelope);
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const signature = opts.signature ?? sign(ts, raw);
  return fetchApi("/api/slack/events", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": ts,
    },
  });
}

function eventCallback(event: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "event_callback",
    event_id: `Ev${uid("id")}`,
    authorizations: [{ user_id: BOT }],
    event,
  };
}

/** Find a Slack-created run (dev org) by its exact cleaned prompt. */
async function findRunByPrompt(prompt: string): Promise<any | null> {
  const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
  return body.runs.find((r) => r.prompt === prompt) ?? null;
}

describe("slack signature verification", () => {
  test("url_verification handshake echoes the challenge (signed)", async () => {
    const res = await postSlack({ type: "url_verification", challenge: "c-123" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "c-123" });
  });

  test("a bad signature is rejected 401", async () => {
    const res = await postSlack({ type: "url_verification", challenge: "x" }, {
      signature: "v0=deadbeef",
    });
    expect(res.status).toBe(401);
  });

  test("a stale timestamp (>5m) is rejected 401", async () => {
    const old = (Math.floor(Date.now() / 1000) - 600).toString();
    // Sign correctly for the stale ts — it must still fail on the skew check.
    const res = await postSlack({ type: "url_verification", challenge: "x" }, {
      timestamp: old,
    });
    expect(res.status).toBe(401);
  });

  test("a missing signature header is rejected 401", async () => {
    const res = await fetchApi("/api/slack/events", {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "x" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});

describe("slack event → run", () => {
  test("app_mention creates a root run, 👀-acks, and posts the summary", async () => {
    const marker = uid("mention");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const res = await postSlack(
      eventCallback({
        type: "app_mention",
        channel,
        user: "U-HUMAN",
        text: `<@${BOT}> build ${marker}`,
        ts,
      }),
    );
    expect(res.status).toBe(200);

    // Prompt is cleaned (mention stripped) and scoped to the dev org.
    const run = await waitFor(async () => findRunByPrompt(`build ${marker}`));
    expect(run.prompt).toBe(`build ${marker}`);
    expect(run.org_id).toBe("org-skynet-dev");
    expect(run.parent_run_id).toBeNull();
    expect(run.thread_id).toBe(run.id); // a root run threads under itself

    // 👀 ack targeted the triggering message (now delivered via the durable
    // outbox relay, so wait for it rather than asserting synchronously).
    await waitFor(async () =>
      rec.reactions.some((r) => r.channel === channel && r.timestamp === ts && r.name === "eyes") || null,
    );

    // On completion the summary is posted back into the Slack thread (thread_ts = message ts).
    const msg = await waitFor(async () =>
      rec.messages.find((m) => m.channel === channel && m.threadTs === ts) ?? null,
    );
    expect(msg.text.length).toBeGreaterThan(0);
    const done = await json<any>(`/api/runs/${run.id}`);
    expect(msg.text).toBe(done.body.summary);
  });

  test("a thread reply becomes a parent_run_id follow-up in the same thread", async () => {
    const marker = uid("thread");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("ts")}.1`;

    await postSlack(
      eventCallback({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> root ${marker}`, ts: rootTs }),
    );
    const root = await waitFor(async () => findRunByPrompt(`root ${marker}`));

    // A mention inside the same Slack thread (Slack sends app_mention w/ thread_ts).
    await postSlack(
      eventCallback({
        type: "app_mention",
        channel,
        user: "U-HUMAN",
        text: `<@${BOT}> more ${marker}`,
        ts: `${uid("ts")}.2`,
        thread_ts: rootTs,
      }),
    );
    const reply = await waitFor(async () => findRunByPrompt(`more ${marker}`));

    expect(reply.parent_run_id).toBe(root.id);
    expect(reply.thread_id).toBe(root.id); // shares the root's thread

    // The whole thread reads back oldest→newest from the run API.
    const thread = await json<{ thread: any[] }>(`/api/runs/${root.id}?thread=1`);
    expect(thread.body.thread.map((r) => r.id)).toEqual([root.id, reply.id]);
  });

  test("a non-mention thread reply is followed when the bot rooted that thread", async () => {
    const marker = uid("follow");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("ts")}.1`;
    await postSlack(
      eventCallback({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> start ${marker}`, ts: rootTs }),
    );
    const root = await waitFor(async () => findRunByPrompt(`start ${marker}`));

    // Plain channel message (NO mention) in the known thread → still ours.
    await postSlack(
      eventCallback({
        type: "message",
        channel,
        channel_type: "channel",
        user: "U-HUMAN",
        text: `follow ${marker}`,
        ts: `${uid("ts")}.2`,
        thread_ts: rootTs,
      }),
    );
    const follow = await waitFor(async () => findRunByPrompt(`follow ${marker}`));
    expect(follow.parent_run_id).toBe(root.id);
  });

  test("a DM message creates a run without a mention", async () => {
    const marker = uid("dm");
    const res = await postSlack(
      eventCallback({
        type: "message",
        channel: `D${uid("dm")}`,
        channel_type: "im",
        user: "U-HUMAN",
        text: `hey ${marker}`,
        ts: `${uid("ts")}.1`,
      }),
    );
    expect(res.status).toBe(200);
    const run = await waitFor(async () => findRunByPrompt(`hey ${marker}`));
    expect(run.parent_run_id).toBeNull();
  });

  test("duplicate delivery (same channel:ts) creates only one run", async () => {
    const marker = uid("dup");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const event = { type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> once ${marker}`, ts };
    // Slack retries reuse the same (channel, ts); envelopes may differ (event_id).
    await postSlack(eventCallback(event));
    await postSlack(eventCallback(event));
    await waitFor(async () => findRunByPrompt(`once ${marker}`));

    const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
    expect(body.runs.filter((r) => r.prompt === `once ${marker}`).length).toBe(1);
  });

  test("a non-mention channel message in an unknown thread is ignored", async () => {
    const marker = uid("ignore");
    const res = await postSlack(
      eventCallback({
        type: "message",
        channel: `C${uid("ch")}`,
        channel_type: "channel",
        user: "U-HUMAN",
        text: `noise ${marker}`,
        ts: `${uid("ts")}.1`,
      }),
    );
    expect(res.status).toBe(200); // acknowledged...
    // ...but no run created (give any async work a beat to NOT happen).
    await new Promise((r) => setTimeout(r, 150));
    expect(await findRunByPrompt(`noise ${marker}`)).toBeNull();
  });

  test("the bot's own message is ignored (loop guard)", async () => {
    const marker = uid("self");
    await postSlack(
      eventCallback({
        type: "message",
        channel: `D${uid("dm")}`,
        channel_type: "im",
        user: BOT, // authored by the bot itself
        text: `echo ${marker}`,
        ts: `${uid("ts")}.1`,
      }),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(await findRunByPrompt(`echo ${marker}`)).toBeNull();
  });

  test("assistant status: shimmer set on start, cleared before the summary posts", async () => {
    const marker = uid("status");
    const channel = `D${uid("dm")}`;
    const ts = `${uid("ts")}.1`;
    await postSlack(
      eventCallback({ type: "message", channel, channel_type: "im", user: "U-HUMAN", text: `go ${marker}`, ts }),
    );
    const run = await waitFor(async () => findRunByPrompt(`go ${marker}`));

    // Summary posted on completion…
    await waitFor(async () => rec.messages.find((m) => m.channel === channel && m.threadTs === ts) ?? null);

    // …and the assistant shimmer bracketed the run: "Starting up…" first, "" (clear) last.
    const mine = rec.statuses.filter((s) => s.channel === channel && s.threadTs === ts);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine[0]?.status).toBe("Starting up…");
    expect(mine[mine.length - 1]?.status).toBe("");
    expect(run.id).toBeTruthy();
  });

  test("assistant status failing (non-assistant context) never blocks the summary post", async () => {
    statusFails = true;
    try {
      const marker = uid("nostatus");
      const channel = `C${uid("ch")}`;
      const ts = `${uid("ts")}.1`;
      await postSlack(
        eventCallback({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> run ${marker}`, ts }),
      );
      await waitFor(async () => findRunByPrompt(`run ${marker}`));
      // setStatus rejects every call, yet the completion post still lands.
      const msg = await waitFor(async () =>
        rec.messages.find((m) => m.channel === channel && m.threadTs === ts) ?? null,
      );
      expect(msg.text.length).toBeGreaterThan(0);
    } finally {
      statusFails = false;
    }
  });
});

// The Socket Mode ingest lane feeds the SAME handleSlackEvent as the HTTP route,
// so a socket-ingested event must create a run AND attach the live-status/reply
// watcher (watchSlackRun) exactly as HTTP does. Drive the frame dispatcher
// directly (no live WebSocket) and assert the full downstream.
describe("slack socket-mode ingest shares the HTTP handler", () => {
  function socketFrame(envelope: Record<string, unknown>, envelopeId = `env-${uid("e")}`): { raw: string; envelopeId: string } {
    return { raw: JSON.stringify({ type: "events_api", envelope_id: envelopeId, payload: envelope }), envelopeId };
  }

  test("an events_api app_mention frame acks, creates a run, and attaches the watcher", async () => {
    const marker = uid("socket");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const acked: string[] = [];
    const { raw, envelopeId } = socketFrame(
      eventCallback({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> socket ${marker}`, ts }),
    );

    dispatchSocketFrame(raw, (id) => acked.push(id), () => {});

    expect(acked).toEqual([envelopeId]); // acked by envelope_id, before processing

    // Run created via the shared handler, scoped to the dev org.
    const run = await waitFor(async () => findRunByPrompt(`socket ${marker}`));
    expect(run.org_id).toBe("org-skynet-dev");

    // watchSlackRun attached downstream: the 👀 ack + the completion summary land.
    await waitFor(async () =>
      rec.reactions.some((r) => r.channel === channel && r.timestamp === ts && r.name === "eyes") || null,
    );
    const msg = await waitFor(async () =>
      rec.messages.find((m) => m.channel === channel && m.threadTs === ts) ?? null,
    );
    expect(msg.text.length).toBeGreaterThan(0);
  });

  test("hello is a no-op; disconnect asks us to close", () => {
    let closed = 0;
    dispatchSocketFrame(JSON.stringify({ type: "hello" }), () => {}, () => closed++);
    expect(closed).toBe(0);
    dispatchSocketFrame(JSON.stringify({ type: "disconnect" }), () => {}, () => closed++);
    expect(closed).toBe(1);
  });
});
