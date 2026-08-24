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
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { artifacts, runs, slackOutbox, slackRunResponses, slackThreads, userUploads } from "../src/db/schema";
import { artifactStorage } from "../src/artifacts/storage";
import { finalizeRun } from "../src/runs/finalize";
import { createRun } from "../src/runs/repo";
import {
  createSlackRunResponse,
  findSlackRunResponse,
  linkSlackThread,
} from "../src/slack/repo";
import { enqueuePostCard } from "../src/slack/outbox";
import { buildRunCard } from "../src/slack/card";
import { DEV_ORG_ID, DEV_USER_ID } from "../src/seed";
import { setSlackClientForTest } from "../src/slack";
import { resetSlackDeduperForTest } from "../src/slack/events";
import { setInboundFileDownloaderForTest } from "../src/slack/inbound-files";
import { dispatchSocketFrame } from "../src/slack/socket-mode";
import { composeSlackReplyText } from "../src/slack/reply";
import {
  findSlackUser,
  findSlackWorkspace,
  syncSlackWorkspaceBindings,
  upsertSlackUser,
  upsertSlackWorkspace,
} from "../src/slack/workspaces";
import { fetchApi, json, uid, waitFor } from "./helpers";

// This DB-backed integration suite shares the CI Postgres service with the
// full backend matrix. Keep its bounded async waits above Bun's 5s unit-test
// default so normal runner contention is not misclassified as a product hang.
setDefaultTimeout(15_000);

const SECRET = "test-signing-secret"; // this suite signs every inbound event with it
const BOT = "U0BOTBOT";
// The mapped test workspace: registered in beforeAll (slack_workspaces), so its
// events are attributed to the dev org/user. Unmapped teams must be IGNORED.
const TEAM = "T0TESTTEAM";

// Hermetic Slack env. Bun auto-loads backend/.env, so the REAL SLACK_* creds
// leak into the test process and would override what this suite assumes: the
// real signing secret makes every signed event fail verification (401), and a
// real app token could open a live Socket Mode WS. Pin the values this suite
// depends on and restore whatever .env carried, so it is hermetic regardless of
// the machine's .env.
const SLACK_ENV_OVERRIDES: Record<string, string | undefined> = {
  SLACK_SIGNING_SECRET: SECRET,
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_LEGACY_TEAM_ID: TEAM,
  SLACK_APP_TOKEN: undefined, // keep a real app token out of the suite entirely
  // Operator scoping must not leak in from a machine's .env: an allowlist
  // would silently drop this suite's random channels, org/user pinning would
  // break the dev-org assertions, and a real engine/model selection (codex)
  // needs live provider credentials this suite does not have.
  SLACK_CHANNEL_ALLOWLIST: undefined,
  SLACK_DEFAULT_ORG_ID: undefined,
  SLACK_DEFAULT_USER_ID: undefined,
  SLACK_DEFAULT_ENGINE: undefined,
  SLACK_DEFAULT_MODEL: undefined,
};
const savedSlackEnv: Record<string, string | undefined> = {};

interface Recorded {
  reactions: Array<{ channel: string; timestamp: string; name: string }>;
  messages: Array<{ channel: string; text: string; threadTs?: string; blocks?: unknown[] }>;
  updates: Array<{ channel: string; ts: string; text: string; blocks?: unknown[] }>;
  sessionStatuses: Array<{ channel: string; threadTs: string; status: "processing" | "active" }>;
  streams: Array<{
    op: "start" | "append" | "stop";
    channel: string;
    threadTs: string;
    messageTs?: string;
    blocks?: readonly unknown[];
    chunks?: readonly unknown[];
  }>;
  uploads: Array<{ channel: string; filename: string; threadTs?: string; bytes: Buffer }>;
}
const rec: Recorded = { reactions: [], messages: [], updates: [], sessionStatuses: [], streams: [], uploads: [] };
/** When true the mock rejects agents.sessions.setStatus — the non-assistant fallback case. */
let statusFails = false;
/** When set, chat.update returns this failure (drives the update-fallback path). */
let updateResult: import("../src/slack/client").DeliveryResult = { ok: true };
/** When set, chat.stopStream returns this failure (drives stream fallback paths). */
let stopStreamResult: import("../src/slack/client").DeliveryResult = { ok: true };
/** Synthetic message ts source — the card post returns one so updates can target it. */
let tsSeq = 1000;

/** The FINAL answer text delivered to a thread: the last card update (in place)
 *  when the card path drove it, else the last posted message. One helper so an
 *  assertion is agnostic to whether the answer updated the card or fell back to a
 *  fresh post. */
function finalAnswerFor(channel: string, threadTs: string): string | null {
  const stopped = [...rec.streams].reverse().find((s) => s.op === "stop" && s.channel === channel && s.threadTs === threadTs);
  if (stopped?.chunks) {
    const text = stopped.chunks
      .map((chunk) =>
        chunk && typeof chunk === "object" && "markdown_text" in chunk
          ? String((chunk as { markdown_text: unknown }).markdown_text)
          : "",
      )
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  const update = [...rec.updates].reverse().find((u) => u.channel === channel);
  if (update) return update.text;
  const msg = [...rec.messages].reverse().find((m) => m.channel === channel && m.threadTs === threadTs);
  return msg?.text ?? null;
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(SLACK_ENV_OVERRIDES)) {
    savedSlackEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Bind the test workspace to the dev org/user — ingress fails closed for any
  // team without such a row (covered below).
  await upsertSlackWorkspace({ teamId: TEAM, orgId: DEV_ORG_ID, userId: DEV_USER_ID });
  await upsertSlackUser({
    teamId: TEAM,
    slackUserId: "U-HUMAN",
    orgId: DEV_ORG_ID,
    userId: DEV_USER_ID,
  });
  setSlackClientForTest({
    addReaction: async (a) => {
      rec.reactions.push(a);
      return { ok: true };
    },
    postMessage: async (m) => {
      rec.messages.push(m);
      // A card post (carries blocks) returns a ts so later chat.update targets it.
      return m.blocks ? { ok: true, ts: `${tsSeq++}.1` } : { ok: true };
    },
    updateMessage: async (u) => {
      if (updateResult.ok) rec.updates.push(u);
      return updateResult;
    },
    setSessionStatus: async (s) => {
      if (statusFails) return { ok: false, class: "permanent", message: "invalid_thread" };
      rec.sessionStatuses.push(s);
      return { ok: true };
    },
    startStream: async (s) => {
      rec.streams.push({ op: "start", channel: s.channel, threadTs: s.threadTs, chunks: s.chunks });
      return { ok: true, ts: `${tsSeq++}.1` };
    },
    appendStream: async (s) => {
      rec.streams.push({ op: "append", channel: s.channel, threadTs: s.threadTs, messageTs: s.messageTs, chunks: s.chunks });
      return { ok: true };
    },
    stopStream: async (s) => {
      rec.streams.push({ op: "stop", channel: s.channel, threadTs: s.threadTs, messageTs: s.messageTs, chunks: s.chunks, blocks: s.blocks });
      return stopStreamResult;
    },
    uploadFile: async (u) => {
      rec.uploads.push(u);
      return { ok: true };
    },
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
  opts: { timestamp?: string; signature?: string; headers?: Record<string, string> } = {},
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
      ...(opts.headers ?? {}),
    },
  });
}

function eventCallback(
  event: Record<string, unknown>,
  /** The envelope's workspace; `null` omits team_id entirely (fail-closed case). */
  teamId: string | null = TEAM,
): Record<string, unknown> {
  return {
    type: "event_callback",
    event_id: `Ev${uid("id")}`,
    ...(teamId === null ? {} : { team_id: teamId }),
    authorizations: [{ user_id: BOT }],
    event,
  };
}

/** Find a Slack-created run (dev org) by its exact cleaned prompt. */
async function findRunByPrompt(prompt: string): Promise<any | null> {
  const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
  return body.runs.find((r) => r.prompt === prompt) ?? null;
}

async function deleteSlackDeliveryRows(runId: string, teamId = TEAM): Promise<void> {
  await db.delete(slackRunResponses).where(eq(slackRunResponses.runId, runId));
  await db.execute(sql`
    delete from ${slackOutbox}
    where idempotency_key in (
      ${`slack-status:start:${teamId}:${runId}`},
      ${`slack-stream:start:${teamId}:${runId}`},
      ${`slack-status:final:${teamId}:${runId}`},
      ${`slack-reply:${teamId}:${runId}`}
    )
  `);
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
  test("an unavailable linked GitHub repo blocks the run with actionable guidance", async () => {
    const marker = uid("repo");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const res = await postSlack(
      eventCallback({
        type: "app_mention",
        channel,
        user: "U-HUMAN",
        text: `<@${BOT}> test ${marker} <https://github.com/upstream-org/backend/pull/19625>`,
        ts,
      }),
    );
    expect(res.status).toBe(200);
    const outcome = await waitFor(async () => {
      const run = await findRunByPrompt(
        `test ${marker} <https://github.com/upstream-org/backend/pull/19625>`,
      );
      const guidance = rec.messages.find(
        (message) =>
          message.channel === channel &&
          message.threadTs === ts &&
          /upstream-org\/backend/i.test(message.text) &&
          /access|connect|select/i.test(message.text),
      );
      return run || guidance ? { run, guidance } : null;
    });
    expect(outcome.run).toBeNull();
    expect(outcome.guidance?.text).toMatch(/access|connect|select/i);
  });

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
    const [persisted] = await db
      .select({ origin: runs.origin })
      .from(runs)
      .where(eq(runs.id, run.id))
      .limit(1);
    expect(persisted?.origin).toBeNull();

    // 👀 ack targeted the triggering message (now delivered via the durable
    // outbox relay, so wait for it rather than asserting synchronously).
    await waitFor(async () =>
      rec.reactions.some((r) => r.channel === channel && r.timestamp === ts && r.name === "eyes") || null,
    );

    // A Slack-native stream opens in the thread; on settle it is stopped with
    // final chunks and Block Kit blocks.
    await waitFor(async () =>
      rec.streams.find((s) => s.op === "start" && s.channel === channel && s.threadTs === ts) ?? null,
    );
    const answer = await waitFor(async () => finalAnswerFor(channel, ts));
    expect(answer!.length).toBeGreaterThan(0);
    const done = await json<any>(`/api/runs/${run.id}`);
    expect(answer).toBe(composeSlackReplyText(done.body.status, done.body.summary));
    const stopped = rec.streams.find((s) => s.op === "stop" && s.channel === channel && s.threadTs === ts);
    const actions = (stopped?.blocks as any[]).find((b) => b.type === "actions");
    expect(actions.elements[0].url).toContain(`/session/${run.thread_id}`);
  });

  test("a model directive picks the model for a new thread and strips from the prompt", async () => {
    const marker = uid("directive");
    const channel = `C${uid("ch")}`;
    const res = await postSlack(
      eventCallback({
        type: "app_mention",
        channel,
        user: "U-HUMAN",
        text: `<@${BOT}> model:sonnet build ${marker}`,
        ts: `${uid("ts")}.1`,
      }),
    );
    expect(res.status).toBe(200);
    const run = await waitFor(async () => findRunByPrompt(`build ${marker}`));
    expect(run.model).toBe("claude-sonnet-5");
    expect(run.engine).toBe("opencode");
  });

  test("a mid-thread engine switch request gets guidance instead of a cross-engine run", async () => {
    const marker = uid("engswitch");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("ts")}.1`;
    await postSlack(
      eventCallback({
        type: "app_mention",
        channel,
        user: "U-HUMAN",
        text: `<@${BOT}> build ${marker}`,
        ts: rootTs,
      }),
    );
    const root = await waitFor(async () => findRunByPrompt(`build ${marker}`));

    const res = await postSlack(
      eventCallback({
        type: "message",
        channel,
        user: "U-HUMAN",
        text: `engine:codex continue ${marker}`,
        ts: `${uid("ts")}.2`,
        thread_ts: rootTs,
      }),
    );
    expect(res.status).toBe(200);
    // Guidance reply lands in the thread; NO cross-engine run is created.
    const msg = await waitFor(async () =>
      rec.messages.find((m) => m.channel === channel && m.threadTs === rootTs && m.text.includes("cannot switch engines")) ?? null,
    );
    expect(msg.text).toContain(root.engine);
    expect(await findRunByPrompt(`continue ${marker}`)).toBeNull();
  });

  test("a completed slack run shares its artifacts back into the thread", async () => {
    // Build a running run directly (finalizeRun is now first-writer-wins, so a
    // re-finalize of an already-settled run is a no-op by design - the artifact
    // must exist BEFORE the single finalize). Root a Slack thread, publish the
    // artifact, then finalize ONCE as completed.
    const runId = crypto.randomUUID();
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    await createRun({ id: runId, prompt: "share build", model: "claude-opus-5", engine: "mock", orgId: DEV_ORG_ID, userId: null, parentRunId: null, threadId: runId });
    await linkSlackThread({ teamId: TEAM, channel, threadTs: ts, rootRunId: runId, orgId: DEV_ORG_ID });
    await createSlackRunResponse({ runId, teamId: TEAM, channel, threadTs: ts });
    const storageKey = "c".repeat(64); // content-addressed: keys are sha256 hex
    await artifactStorage().put(storageKey, Buffer.from("png-bytes"));
    await db.insert(artifacts).values({
      orgId: DEV_ORG_ID,
      runId,
      threadId: runId,
      sourcePath: "/work/shot.png",
      name: "shot.png",
      contentType: "image/png",
      sizeBytes: 9,
      sha256: "b".repeat(64),
      storageKey,
    });
    await finalizeRun(runId, "completed", "All done, screenshot attached.", 1);

    const upload = await waitFor(async () =>
      rec.uploads.find((u) => u.channel === channel && u.filename === "shot.png") ?? null,
    );
    expect(upload.threadTs).toBe(ts);
    expect(Buffer.from(upload.bytes).toString()).toBe("png-bytes");
  });

  test("a long reply is CHUNKED into sequential thread messages, in order", async () => {
    // Root a Slack thread directly (no HTTP round trip needed) and finalize with
    // a summary far past one Slack message: the outbox relay must deliver it as
    // ordered chunks in the SAME thread, continuation-marked, none truncated.
    const runId = crypto.randomUUID();
    const channel = `C${uid("long")}`;
    const ts = `${uid("ts")}.1`;
    await createRun({ id: runId, prompt: "long reply", model: "claude-opus-5", engine: "mock", orgId: DEV_ORG_ID, userId: null, parentRunId: null, threadId: runId });
    await linkSlackThread({ teamId: TEAM, channel, threadTs: ts, rootRunId: runId, orgId: DEV_ORG_ID });
    await createSlackRunResponse({ runId, teamId: TEAM, channel, threadTs: ts });
    const summary = Array.from({ length: 50 }, (_, i) => `finding ${i}: ${"detail ".repeat(30)}`).join("\n\n");
    await finalizeRun(runId, "completed", summary, 1);

    await waitFor(async () =>
      rec.messages.filter((m) => m.channel === channel).length >= 3 ? true : null,
    );
    const mine = rec.messages.filter((m) => m.channel === channel);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const m of mine) {
      expect(m.threadTs).toBe(ts); // every chunk stays in the thread
      expect(m.text.length).toBeLessThanOrEqual(3900);
    }
    expect(mine[0]!.text.startsWith("finding 0:")).toBe(true); // head first
    for (const m of mine.slice(0, -1)) expect(m.text.endsWith("_(continued…)_")).toBe(true);
    expect(mine.at(-1)!.text).toContain("finding 49:"); // nothing dropped
  });

  test("the channel allowlist drops events from unlisted channels and admits listed ones", async () => {
    const allowed = `C${uid("ok")}`;
    process.env.SLACK_CHANNEL_ALLOWLIST = ` ${allowed} , C0LISTED2 `;
    try {
      const blockedMarker = uid("blocked");
      const blockedRes = await postSlack(
        eventCallback({
          type: "app_mention",
          channel: `C${uid("nope")}`,
          user: "U-HUMAN",
          text: `<@${BOT}> build ${blockedMarker}`,
          ts: `${uid("ts")}.1`,
        }),
      );
      expect(blockedRes.status).toBe(200); // acked to Slack, silently dropped
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await findRunByPrompt(`build ${blockedMarker}`)).toBeNull();

      const allowedMarker = uid("allowed");
      const allowedRes = await postSlack(
        eventCallback({
          type: "app_mention",
          channel: allowed,
          user: "U-HUMAN",
          text: `<@${BOT}> build ${allowedMarker}`,
          ts: `${uid("ts")}.1`,
        }),
      );
      expect(allowedRes.status).toBe(200);
      const run = await waitFor(async () => findRunByPrompt(`build ${allowedMarker}`));
      expect(run.prompt).toBe(`build ${allowedMarker}`);
    } finally {
      delete process.env.SLACK_CHANNEL_ALLOWLIST;
    }
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

  test("a link-free thread reply reauthorizes a legacy repository before inheriting it", async () => {
    const rootId = crypto.randomUUID();
    const marker = uid("repo-follow");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("ts")}.1`;
    await createRun({
      id: rootId,
      prompt: `test the linked PR ${marker}`,
      model: "claude-opus-5",
      engine: "mock",
      orgId: DEV_ORG_ID,
      userId: DEV_USER_ID,
      parentRunId: null,
      threadId: rootId,
      repos: ["upstream-org/backend:feature/pr-19625"],
      memoryScope: "org",
    });
    await linkSlackThread({
      teamId: TEAM,
      channel,
      threadTs: rootTs,
      rootRunId: rootId,
      orgId: DEV_ORG_ID,
    });

    await postSlack(
      eventCallback({
        type: "message",
        channel,
        channel_type: "channel",
        user: "U-HUMAN",
        text: `verify both deployments ${marker}`,
        ts: `${uid("ts")}.2`,
        thread_ts: rootTs,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await findRunByPrompt(`verify both deployments ${marker}`)).toBeNull();
    await waitFor(
      async () =>
        rec.messages.find(
          (message) =>
            message.channel === channel &&
            message.threadTs === rootTs &&
            message.text.includes("GitHub is not connected"),
        ) ?? null,
      { timeoutMs: 14_000 },
    );
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

    // The official Agents session status clears back to "active" when the run settles.
    await waitFor(
      async () =>
        rec.sessionStatuses.some((s) => s.channel === channel && s.threadTs === ts && s.status === "active") || null,
      { timeoutMs: 14_000 },
    );

    const mine = rec.sessionStatuses.filter((s) => s.channel === channel && s.threadTs === ts);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine[0]?.status).toBe("processing");
    expect(mine[mine.length - 1]?.status).toBe("active");
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
      // setStatus rejects every call, yet the completion surface still lands.
      const answer = await waitFor(async () => finalAnswerFor(channel, ts), { timeoutMs: 14_000 });
      expect(answer!.length).toBeGreaterThan(0);
    } finally {
      statusFails = false;
    }
  });
});

// Slack-native stream delivery keeps the legacy Block Kit card as fallback. The
// durable outbox relay delivers each row; assertions waitFor the delivered state.
describe("slack native stream and Block Kit fallback", () => {
  /** Root a Slack thread with a run, WITHOUT posting a card (card_ts stays null). */
  async function rootThread(prompt: string): Promise<{ runId: string; channel: string; ts: string }> {
    const runId = crypto.randomUUID();
    const channel = `C${uid("card")}`;
    const ts = `${uid("ts")}.1`;
    await createRun({ id: runId, prompt, model: "claude-opus-5", engine: "mock", orgId: DEV_ORG_ID, userId: null, parentRunId: null, threadId: runId });
    await linkSlackThread({ teamId: TEAM, channel, threadTs: ts, rootRunId: runId, orgId: DEV_ORG_ID });
    await createSlackRunResponse({ runId, teamId: TEAM, channel, threadTs: ts });
    return { runId, channel, ts };
  }

  test("post_card posts blocks + a url button and stores the returned message ts", async () => {
    const { runId, channel, ts } = await rootThread("card post");
    const card = buildRunCard({
      title: "card post",
      phase: "queued",
      model: "claude-opus-5",
      repoSpecs: [{ repo: "loop/backend", branch: "main" }],
      webUrl: `https://app.example.com/session/${runId}`,
    });
    await enqueuePostCard({
      idempotencyKey: `slack-card:${TEAM}:${runId}`,
      teamId: TEAM,
      channel,
      threadTs: ts,
      runId,
      blocks: card.blocks,
      text: card.text,
    });

    const posted = await waitFor(async () =>
      rec.messages.find((m) => m.channel === channel && m.blocks) ?? null,
    );
    const actions = (posted.blocks as any[]).find((b) => b.type === "actions");
    expect(actions.elements[0].url).toBe(`https://app.example.com/session/${runId}`);
    // The returned ts is persisted on the thread for later chat.update.
    const link = await waitFor(async () => {
      const l = await findSlackRunResponse(runId);
      return l?.fallbackMessageTs ? l : null;
    });
    expect(link.fallbackMessageTs).toBeTruthy();
  });

  test("finalize updates the fallback card when only a fallback message ts exists", async () => {
    const { runId, channel, ts } = await rootThread("stream stop");
    const queued = buildRunCard({ title: "stream stop", phase: "queued", model: "m", repoSpecs: [], webUrl: "https://x/session/1" });
    await enqueuePostCard({ idempotencyKey: `slack-card:${TEAM}:${runId}`, teamId: TEAM, channel, threadTs: ts, runId, blocks: queued.blocks, text: queued.text });
    const cardTs = (await waitFor(async () => {
      const l = await findSlackRunResponse(runId);
      return l?.fallbackMessageTs ? l : null;
    })).fallbackMessageTs!;
    expect(cardTs).toBeTruthy();

    const beforeMessages = rec.messages.length;
    await finalizeRun(runId, "completed", "the answer", 1);
    const update = await waitFor(async () =>
      rec.updates.find((u) => u.channel === channel && u.ts === cardTs) ?? null,
    );
    expect(update.channel).toBe(channel);
    expect(finalAnswerFor(channel, ts)).toBe(composeSlackReplyText("completed", "the answer"));
    // Re-finalizing never double-posts (idempotent by slack-reply:<runId>).
    const before = rec.streams.length + rec.updates.length + rec.messages.length;
    await finalizeRun(runId, "completed", "the answer", 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(rec.streams.length + rec.updates.length + rec.messages.length).toBe(before);
    expect(rec.messages.length).toBe(beforeMessages);
  });

  test("update_card falls back to a plain post when there is NO card ts (answer never lost)", async () => {
    const { runId, channel, ts } = await rootThread("no card");
    // No post_card enqueued → card_ts is null. Finalize must still deliver the
    // answer as a plain message.
    await finalizeRun(runId, "completed", "fallback answer", 1);
    const msg = await waitFor(async () =>
      rec.messages.find((m) => m.channel === channel && m.threadTs === ts && !m.blocks && m.text.includes("fallback answer")) ?? null,
    );
    expect(msg.text).toContain("fallback answer");
    // Nothing was updated (no card to update).
    expect(rec.updates.some((u) => u.channel === channel)).toBe(false);
  });

  test("permanent stream and card update failures fall back to a fresh reply", async () => {
    const { runId, channel, ts } = await rootThread("stream update fails");
    const queued = buildRunCard({ title: "stream update fails", phase: "queued", model: "m", repoSpecs: [], webUrl: "https://x/session/1" });
    await enqueuePostCard({ idempotencyKey: `slack-card:${TEAM}:${runId}`, teamId: TEAM, channel, threadTs: ts, runId, blocks: queued.blocks, text: queued.text });
    await waitFor(async () => {
      const l = await findSlackRunResponse(runId);
      return l?.fallbackMessageTs ? true : null;
    });

    stopStreamResult = { ok: false, class: "permanent", message: "stream_not_found" };
    updateResult = { ok: false, class: "permanent", message: "message_not_found" };
    try {
      await finalizeRun(runId, "completed", "recovered answer", 1);
      // The permanent stream/card failures must not strand the answer: it posts fresh.
      const msg = await waitFor(async () =>
        rec.messages.find((m) => m.channel === channel && !m.blocks && m.text.includes("recovered answer")) ?? null,
      );
      expect(msg.threadTs).toBe(ts);
    } finally {
      stopStreamResult = { ok: true };
      updateResult = { ok: true };
    }
  });

  test("progress fallback card carries a 'working: <step>' line", () => {
    const running = buildRunCard({ title: "progress", phase: "running", model: "m", repoSpecs: [], webUrl: "https://x/session/1", workingStep: "cloning repo" });
    const contexts = (running.blocks as any[]).filter((b) => b.type === "context");
    expect(contexts.some((c) => c.elements[0].text.includes("working: cloning repo"))).toBe(true);
  });
});

// Durable inbound dedupe: the command lane is keyed by the Slack event identity
// (slack-event:<team>:<event_id>, channel:ts fallback), so a duplicate that
// OUTLIVES the in-memory deduper (process restart, cross-lane double delivery)
// still collapses to one run. resetSlackDeduperForTest simulates the restart.
describe("slack durable inbound dedupe (survives a restart)", () => {
  test("the same event_id re-delivered after a 'restart' does not create a second run", async () => {
    const marker = uid("durable");
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> durable ${marker}`,
      ts: `${uid("ts")}.1`,
    });
    await postSlack(envelope);
    await waitFor(async () => findRunByPrompt(`durable ${marker}`));

    resetSlackDeduperForTest(); // the in-memory fast path forgets everything
    const res = await postSlack(envelope); // same event_id -> durable replay
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
    expect(body.runs.filter((r) => r.prompt === `durable ${marker}`).length).toBe(1);
  });

  test("replay heals a missing response row and non-terminal start stream", async () => {
    const marker = uid("healstart");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const envelope = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> heal ${marker}`,
      ts,
    });
    await postSlack(envelope);
    const run = await waitFor(async () => findRunByPrompt(`heal ${marker}`));
    await waitFor(async () => finalAnswerFor(channel, ts));

    await db.update(runs).set({ status: "queued", summary: null }).where(eq(runs.id, run.id));
    await deleteSlackDeliveryRows(run.id);
    const beforeStarts = rec.streams.filter((s) => s.op === "start" && s.channel === channel && s.threadTs === ts).length;
    resetSlackDeduperForTest();

    expect((await postSlack(envelope)).status).toBe(200);

    await waitFor(async () => {
      const response = await findSlackRunResponse(run.id);
      const starts = rec.streams.filter((s) => s.op === "start" && s.channel === channel && s.threadTs === ts);
      return response && starts.length > beforeStarts ? { response, starts } : null;
    });
    expect(rec.sessionStatuses.some((s) => s.channel === channel && s.threadTs === ts && s.status === "processing")).toBe(true);
    expect(rec.reactions.some((r) => r.channel === channel && r.timestamp === ts && r.name === "eyes")).toBe(true);
  });

  test("replay heals a missing response row for an already-terminal run", async () => {
    const marker = uid("healfinal");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const envelope = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> final ${marker}`,
      ts,
    });
    await postSlack(envelope);
    const run = await waitFor(async () => findRunByPrompt(`final ${marker}`));
    await waitFor(async () => finalAnswerFor(channel, ts));

    await deleteSlackDeliveryRows(run.id);
    const beforeMessages = rec.messages.filter((m) => m.channel === channel && m.threadTs === ts && !m.blocks).length;
    resetSlackDeduperForTest();

    expect((await postSlack(envelope)).status).toBe(200);

    const healed = await waitFor(async () => {
      const response = await findSlackRunResponse(run.id);
      const replies = rec.messages.filter((m) => m.channel === channel && m.threadTs === ts && !m.blocks);
      return response && replies.length > beforeMessages ? replies.at(-1) : null;
    });
    expect(healed.text.length).toBeGreaterThan(0);
    expect(rec.sessionStatuses.some((s) => s.channel === channel && s.threadTs === ts && s.status === "active")).toBe(true);
  });

  test("an attachment replay returns before restaging provider files", async () => {
    let downloads = 0;
    setInboundFileDownloaderForTest(async () => {
      downloads += 1;
      return new TextEncoder().encode("dup bytes");
    });
    try {
      const marker = uid("dupconflict");
      const envelope = eventCallback({
        type: "message",
        channel: `D${uid("dm")}`,
        channel_type: "im",
        user: "U-HUMAN",
        text: `attach ${marker}`,
        ts: `${uid("ts")}.1`,
        files: [
          {
            id: `F${uid("f")}`,
            name: `${marker}.txt`,
            size: 9,
            mimetype: "text/plain",
            url_private_download: `https://files.slack.com/files-pri/${TEAM}/${marker}.txt`,
          },
        ],
      });
      await postSlack(envelope);
      await waitFor(async () => findRunByPrompt(`attach ${marker}`));
      expect(downloads).toBe(1);

      resetSlackDeduperForTest();
      // Stable Slack file identity matches the durable raw intent, so the
      // replay is recognized before downloading or staging the file again.
      expect((await postSlack(envelope)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      expect(downloads).toBe(1);
      const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
      expect(body.runs.filter((r) => r.prompt === `attach ${marker}`).length).toBe(1);
    } finally {
      setInboundFileDownloaderForTest(null);
    }
  });

  test("an envelope with NO event_id falls back to the channel:ts durable key", async () => {
    const marker = uid("fallback");
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> fallback ${marker}`,
      ts: `${uid("ts")}.1`,
    });
    delete (envelope as Record<string, unknown>).event_id;
    await postSlack(envelope);
    await waitFor(async () => findRunByPrompt(`fallback ${marker}`));

    resetSlackDeduperForTest();
    expect((await postSlack(envelope)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
    expect(body.runs.filter((r) => r.prompt === `fallback ${marker}`).length).toBe(1);
  });
});

describe("slack legacy team adoption", () => {
  test("a matching __legacy__ thread is atomically adopted for the resolved workspace", async () => {
    const marker = uid("legacy");
    const channel = `C${uid("legacy")}`;
    const rootTs = `${uid("ts")}.1`;
    const rootRunId = crypto.randomUUID();
    await createRun({
      id: rootRunId,
      prompt: `legacy root ${marker}`,
      model: "claude-opus-5",
      engine: "mock",
      orgId: DEV_ORG_ID,
      userId: DEV_USER_ID,
      parentRunId: null,
      threadId: rootRunId,
      repos: [],
      memoryScope: "org",
    });
    await db.insert(slackThreads).values({
      teamId: "__legacy__",
      channel,
      threadTs: rootTs,
      rootRunId,
      orgId: DEV_ORG_ID,
    });
    await createSlackRunResponse({ runId: rootRunId, teamId: "__legacy__", channel, threadTs: rootTs });

    const res = await postSlack(
      eventCallback({
        type: "message",
        channel,
        user: "U-HUMAN",
        text: `continue ${marker}`,
        ts: `${uid("ts")}.2`,
        thread_ts: rootTs,
      }),
    );
    expect(res.status).toBe(200);

    const reply = await waitFor(async () => findRunByPrompt(`continue ${marker}`));
    expect(reply.parent_run_id).toBe(rootRunId);
    const [adopted] = await db.select().from(slackThreads).where(eq(slackThreads.rootRunId, rootRunId)).limit(1);
    expect(adopted?.teamId).toBe(TEAM);
    const rootResponse = await findSlackRunResponse(rootRunId);
    expect(rootResponse?.teamId).toBe(TEAM);
  });

  test("a cross-org __legacy__ thread is not adopted", async () => {
    const marker = uid("legacyxorg");
    const channel = `C${uid("legacy")}`;
    const rootTs = `${uid("ts")}.1`;
    const rootRunId = crypto.randomUUID();
    await createRun({
      id: rootRunId,
      prompt: `legacy cross root ${marker}`,
      model: "claude-opus-5",
      engine: "mock",
      orgId: DEV_ORG_ID,
      userId: DEV_USER_ID,
      parentRunId: null,
      threadId: rootRunId,
      repos: [],
      memoryScope: "org",
    });
    await db.insert(slackThreads).values({
      teamId: "__legacy__",
      channel,
      threadTs: rootTs,
      rootRunId,
      orgId: "org-other",
    });

    expect((await postSlack(eventCallback({
      type: "message",
      channel,
      user: "U-HUMAN",
      text: `ignored ${marker}`,
      ts: `${uid("ts")}.2`,
      thread_ts: rootTs,
    }))).status).toBe(200);

    await new Promise((r) => setTimeout(r, 300));
    expect(await findRunByPrompt(`ignored ${marker}`)).toBeNull();
    const [legacy] = await db.select().from(slackThreads).where(eq(slackThreads.rootRunId, rootRunId)).limit(1);
    expect(legacy?.teamId).toBe("__legacy__");
  });
});

// Ack-first ingress: the events route 200s immediately after signature
// verification; processing (staging, acceptance) happens BEHIND the ack.
describe("slack ack-first ingress", () => {
  test("the 200 does not wait for event processing (slow attachment staging)", async () => {
    // A 600ms attachment download would blow a synchronous handler way past
    // this assertion; ack-first returns while staging is still in flight.
    setInboundFileDownloaderForTest(async () => {
      await new Promise((r) => setTimeout(r, 600));
      return new TextEncoder().encode("slow bytes");
    });
    try {
      const marker = uid("ackfirst");
      const started = Date.now();
      const res = await postSlack(
        eventCallback({
          type: "message",
          channel: `D${uid("dm")}`,
          channel_type: "im",
          user: "U-HUMAN",
          text: `stage ${marker}`,
          ts: `${uid("ts")}.1`,
          files: [
            {
              id: `F${uid("f")}`,
              name: `${marker}.txt`,
              size: 10,
              mimetype: "text/plain",
              url_private_download: `https://files.slack.com/files-pri/${TEAM}/${marker}.txt`,
            },
          ],
        }),
      );
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(400); // acked BEFORE the 600ms download
      // The event still fully processes after the ack.
      const run = await waitFor(async () => findRunByPrompt(`stage ${marker}`));
      expect(run.id).toBeTruthy();
    } finally {
      setInboundFileDownloaderForTest(null);
    }
  });

  test("a Slack retry delivery (x-slack-retry-num) is acked without a second run", async () => {
    const marker = uid("retry");
    const channel = `C${uid("ch")}`;
    const envelope = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> retry ${marker}`,
      ts: `${uid("ts")}.1`,
    });
    await postSlack(envelope);
    await waitFor(async () => findRunByPrompt(`retry ${marker}`));

    const res = await postSlack(envelope, { headers: { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" } });
    expect(res.status).toBe(200); // acked immediately...
    await new Promise((r) => setTimeout(r, 300));
    const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
    expect(body.runs.filter((r) => r.prompt === `retry ${marker}`).length).toBe(1); // ...never reprocessed
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

    // watchSlackRun attached downstream: the 👀 ack + native stream land, and the
    // settled answer stops the stream.
    await waitFor(async () =>
      rec.reactions.some((r) => r.channel === channel && r.timestamp === ts && r.name === "eyes") || null,
    );
    await waitFor(async () => rec.streams.find((s) => s.op === "start" && s.channel === channel && s.threadTs === ts) ?? null);
    const answer = await waitFor(async () => finalAnswerFor(channel, ts));
    expect(answer!.length).toBeGreaterThan(0);
  });

  test("hello is a no-op; disconnect asks us to close", () => {
    let closed = 0;
    dispatchSocketFrame(JSON.stringify({ type: "hello" }), () => {}, () => closed++);
    expect(closed).toBe(0);
    dispatchSocketFrame(JSON.stringify({ type: "disconnect" }), () => {}, () => closed++);
    expect(closed).toBe(1);
  });
});

// Workspace identity fails CLOSED: only events from a team with a
// slack_workspaces mapping are accepted; there is no seeded-org fallback.
describe("slack workspace identity (fail closed)", () => {
  test("rejects an existing thread link owned by another organization", async () => {
    const marker = uid("cross-org");
    const channel = `C${uid("ch")}`;
    const threadTs = `${uid("ts")}.1`;
    const rootRunId = crypto.randomUUID();
    const otherOrgId = `org-other-${uid("org")}`;
    await createRun({
      id: rootRunId,
      prompt: `other org root ${marker}`,
      model: "claude-opus-5",
      engine: "mock",
      orgId: otherOrgId,
      userId: null,
      parentRunId: null,
      threadId: rootRunId,
    });
    await linkSlackThread({
      teamId: TEAM,
      channel,
      threadTs,
      rootRunId,
      orgId: otherOrgId,
    });

    await postSlack(eventCallback({
      type: "message",
      channel,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `cross org ${marker}`,
      ts: `${uid("ts")}.2`,
      thread_ts: threadTs,
    }));

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await findRunByPrompt(`cross org ${marker}`)).toBeNull();
  });

  test("uses an explicit Slack-sender mapping for run attribution", async () => {
    const marker = uid("sender");
    await postSlack(eventCallback({
      type: "message",
      channel: `D${uid("dm")}`,
      channel_type: "im",
      user: "U-HUMAN",
      text: `sender ${marker}`,
      ts: `${uid("ts")}.1`,
    }));
    const run = await waitFor(async () => findRunByPrompt(`sender ${marker}`));
    expect(run.user_id).toBe(DEV_USER_ID);
  });

  test("blocks every run for an unmapped Slack sender", async () => {
    const marker = uid("unmapped-sender");
    const channel = `D${uid("dm")}`;
    await postSlack(eventCallback({
      type: "message",
      channel,
      channel_type: "im",
      user: `U-${uid("unknown")}`,
      text: `summarize this workspace ${marker}`,
      ts: `${uid("ts")}.1`,
    }));

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await findRunByPrompt(`summarize this workspace ${marker}`)).toBeNull();
    await waitFor(async () =>
      rec.messages.find(
        (message) =>
          message.channel === channel &&
          message.text.includes("Slack user is not linked") &&
          message.text.includes("SLACK_USER_BINDINGS"),
      ) ?? null,
    );
  });

  test("an event from an unmapped workspace is ignored", async () => {
    const marker = uid("noteam");
    const res = await postSlack(
      eventCallback(
        {
          type: "app_mention",
          channel: `C${uid("ch")}`,
          user: "U-HUMAN",
          text: `<@${BOT}> hi ${marker}`,
          ts: `${uid("ts")}.1`,
        },
        `T-UNMAPPED-${uid("t")}`,
      ),
    );
    expect(res.status).toBe(200); // acknowledged to Slack...
    await new Promise((r) => setTimeout(r, 150));
    expect(await findRunByPrompt(`hi ${marker}`)).toBeNull(); // ...but no run
  });

  test("an event carrying no team_id at all is ignored", async () => {
    const marker = uid("teamless");
    await postSlack(
      eventCallback(
        {
          type: "app_mention",
          channel: `C${uid("ch")}`,
          user: "U-HUMAN",
          text: `<@${BOT}> hi ${marker}`,
          ts: `${uid("ts")}.1`,
        },
        null,
      ),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(await findRunByPrompt(`hi ${marker}`)).toBeNull();
  });

  test("SLACK_WORKSPACE_BINDINGS syncs mappings at boot (malformed entries skipped)", async () => {
    const team = `T-BIND-${uid("t")}`;
    const saved = process.env.SLACK_WORKSPACE_BINDINGS;
    const savedUsers = process.env.SLACK_USER_BINDINGS;
    process.env.SLACK_WORKSPACE_BINDINGS = `${team}:${DEV_ORG_ID}:${DEV_USER_ID}, malformed-entry`;
    process.env.SLACK_USER_BINDINGS =
      `${team}:U-BOUND:${DEV_ORG_ID}:${DEV_USER_ID}, malformed-user-entry`;
    try {
      await syncSlackWorkspaceBindings();
    } finally {
      if (saved === undefined) delete process.env.SLACK_WORKSPACE_BINDINGS;
      else process.env.SLACK_WORKSPACE_BINDINGS = saved;
      if (savedUsers === undefined) delete process.env.SLACK_USER_BINDINGS;
      else process.env.SLACK_USER_BINDINGS = savedUsers;
    }
    expect(await findSlackWorkspace(team)).toEqual({
      orgId: DEV_ORG_ID,
      userId: DEV_USER_ID,
    });
    expect(await findSlackUser(team, "U-BOUND")).toEqual({
      orgId: DEV_ORG_ID,
      userId: DEV_USER_ID,
    });
    expect(await findSlackWorkspace("malformed-entry")).toBeNull();
  });
});

// Inbound attachments: files on an accepted message are downloaded bounded
// (Slack-hosted URLs only, size + count caps) and staged through the uploads
// lane, then claimed by the created run as its input files.
describe("slack inbound attachments", () => {
  const downloaded: string[] = [];
  let payload = new TextEncoder().encode("hello slack bytes");

  beforeAll(() => {
    setInboundFileDownloaderForTest(async (url) => {
      downloaded.push(url);
      return payload;
    });
  });

  afterAll(() => {
    setInboundFileDownloaderForTest(null);
  });

  function slackFile(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: `F${uid("f")}`,
      name,
      size: payload.byteLength,
      mimetype: "text/plain",
      url_private_download: `https://files.slack.com/files-pri/${TEAM}/${name}`,
      ...extra,
    };
  }

  async function uploadsByName(name: string) {
    return db.select().from(userUploads).where(eq(userUploads.name, name));
  }

  test("a mention with a file stages it and claims it for the created run", async () => {
    const marker = uid("attach");
    const fileName = `${marker}.txt`;
    await postSlack(
      eventCallback({
        type: "app_mention",
        channel: `C${uid("ch")}`,
        user: "U-HUMAN",
        text: `<@${BOT}> summarize ${marker}`,
        ts: `${uid("ts")}.1`,
        files: [slackFile(fileName)],
      }),
    );
    const run = await waitFor(async () => findRunByPrompt(`summarize ${marker}`));

    const rows = await waitFor(async () => {
      const found = await uploadsByName(fileName);
      return found.length > 0 ? found : null;
    });
    expect(rows).toHaveLength(1);
    const upload = rows[0]!;
    expect(upload.runId).toBe(run.id); // claimed atomically with acceptance
    expect(upload.orgId).toBe(DEV_ORG_ID);
    expect(upload.userId).toBe(DEV_USER_ID);
    expect(upload.contentType).toBe("text/plain; charset=utf-8");
    expect(upload.sizeBytes).toBe(payload.byteLength);
    expect(upload.sha256).toBe(
      new Bun.CryptoHasher("sha256").update(payload).digest("hex"),
    );
  });

  test("a files-only DM (file_share subtype, no text) still creates a run", async () => {
    const fileName = `${uid("filesonly")}.txt`;
    await postSlack(
      eventCallback({
        type: "message",
        subtype: "file_share",
        channel: `D${uid("dm")}`,
        channel_type: "im",
        user: "U-HUMAN",
        text: "",
        ts: `${uid("ts")}.1`,
        files: [slackFile(fileName)],
      }),
    );
    const upload = await waitFor(async () => (await uploadsByName(fileName))[0] ?? null);
    expect(upload.runId).toBeTruthy();
    const { body: run } = await json<any>(`/api/runs/${upload.runId}`);
    expect(run.prompt).toBe("Review the attached files.");
  });

  test("count cap: only the first 5 of 7 files are staged", async () => {
    const marker = uid("cap");
    const names = Array.from({ length: 7 }, (_, i) => `${marker}-${i}.txt`);
    await postSlack(
      eventCallback({
        type: "message",
        channel: `D${uid("dm")}`,
        channel_type: "im",
        user: "U-HUMAN",
        text: `cap ${marker}`,
        ts: `${uid("ts")}.1`,
        files: names.map((n) => slackFile(n)),
      }),
    );
    await waitFor(async () => findRunByPrompt(`cap ${marker}`));
    const staged = await waitFor(async () => {
      const rows = await Promise.all(names.map(uploadsByName));
      const flat = rows.flat();
      return flat.length >= 5 ? flat : null;
    });
    expect(staged).toHaveLength(5);
    expect(await uploadsByName(names[5]!)).toHaveLength(0);
    expect(await uploadsByName(names[6]!)).toHaveLength(0);
  });

  test("size cap: an over-declared file is skipped without downloading", async () => {
    const marker = uid("big");
    const fileName = `${marker}.bin`;
    const before = downloaded.length;
    await postSlack(
      eventCallback({
        type: "message",
        channel: `D${uid("dm")}`,
        channel_type: "im",
        user: "U-HUMAN",
        text: `big ${marker}`,
        ts: `${uid("ts")}.1`,
        files: [slackFile(fileName, { size: 21 * 1024 * 1024 })],
      }),
    );
    await waitFor(async () => findRunByPrompt(`big ${marker}`));
    expect(await uploadsByName(fileName)).toHaveLength(0);
    expect(downloaded.length).toBe(before); // rejected on declared size, never fetched
  });

  test("only Slack-hosted https URLs are fetched (bot token never leaves Slack)", async () => {
    const marker = uid("offhost");
    const fileName = `${marker}.txt`;
    const before = downloaded.length;
    await postSlack(
      eventCallback({
        type: "message",
        channel: `D${uid("dm")}`,
        channel_type: "im",
        user: "U-HUMAN",
        text: `offhost ${marker}`,
        ts: `${uid("ts")}.1`,
        files: [
          slackFile(fileName, {
            url_private_download: `https://evil.example.com/steal-token/${fileName}`,
          }),
        ],
      }),
    );
    await waitFor(async () => findRunByPrompt(`offhost ${marker}`));
    expect(await uploadsByName(fileName)).toHaveLength(0);
    expect(downloaded.length).toBe(before);
  });

  test("a lying declared size is caught after download (post-check cap)", async () => {
    const marker = uid("liar");
    const fileName = `${marker}.bin`;
    const original = payload;
    payload = new Uint8Array(20 * 1024 * 1024 + 1); // real bytes over the cap
    try {
      await postSlack(
        eventCallback({
          type: "message",
          channel: `D${uid("dm")}`,
          channel_type: "im",
          user: "U-HUMAN",
          text: `liar ${marker}`,
          ts: `${uid("ts")}.1`,
          files: [slackFile(fileName, { size: 100 })],
        }),
      );
      await waitFor(async () => findRunByPrompt(`liar ${marker}`));
      expect(await uploadsByName(fileName)).toHaveLength(0);
    } finally {
      payload = original;
    }
  });
});
