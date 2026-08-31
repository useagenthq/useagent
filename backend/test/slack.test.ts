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
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { artifacts, commands, runs, slackOutbox, slackRunResponses, slackThreads, userUploads } from "../src/db/schema";
import { artifactStorage } from "../src/artifacts/storage";
import { finalizeRun } from "../src/runs/finalize";
import { createRun } from "../src/runs/repo";
import {
  createSlackRunResponse,
  findSlackRunResponse,
  linkSlackThread,
} from "../src/slack/repo";
import {
  enqueueAppendStream,
  enqueuePostCard,
  enqueueStartStream,
  enqueueThreadStatus,
  getSlackOutbox,
  kickSlackOutbox,
} from "../src/slack/outbox";
import { buildRunCard } from "../src/slack/card";
import { markdownChunksFor, openingStreamChunks, runningTaskChunk } from "../src/slack/streaming";
import { turnStream } from "../src/runs/turn-stream";
import { DEV_ORG_ID, DEV_USER_ID } from "../src/seed";
import { setSlackClientForTest } from "../src/slack";
import { handleSlackEvent, resetSlackDeduperForTest, type SlackEnvelope } from "../src/slack/events";
import { setInboundFileDownloaderForTest } from "../src/slack/inbound-files";
import {
  persistSlackInboxEvent,
  processSlackInbox,
  maintainSlackInboxRetention,
  setSlackInboxBeforePersistInsertForTest,
  setSlackInboxPersisterForTest,
  slackInboxKey,
  slackInboxThreadId,
  SLACK_INBOX_EVENT,
  startSlackInboxPump,
  stopSlackInboxPumpForTest,
  verifySlackInboxIdentity,
  type SlackInboxClaim,
  type SlackInboxOutcome,
  type SlackInboxPayload,
} from "../src/slack/inbox";
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
import { setRunAdmission } from "../src/commands";

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
  threadStatuses: Array<{ channel: string; threadTs: string; status: string }>;
  streams: Array<{
    op: "start" | "append" | "stop";
    channel: string;
    threadTs: string;
    messageTs?: string;
    mode?: string;
    recipientTeamId?: string;
    recipientUserId?: string;
    blocks?: readonly unknown[];
    chunks?: readonly unknown[];
  }>;
  uploads: Array<{ channel: string; filename: string; threadTs?: string; bytes: Buffer }>;
}
const rec: Recorded = {
  reactions: [],
  messages: [],
  updates: [],
  sessionStatuses: [],
  threadStatuses: [],
  streams: [],
  uploads: [],
};
/** When true the mock rejects agents.sessions.setStatus — the non-assistant fallback case. */
let statusFails = false;
/** When set, chat.update returns this failure (drives the update-fallback path). */
let updateResult: import("../src/slack/client").DeliveryResult = { ok: true };
/** When set, chat.startStream returns this failure (drives the fallback-once path). */
let startStreamResult: import("../src/slack/client").DeliveryResult | null = null;
/** When set, chat.appendStream returns this failure (drives the mid-run fallback). */
let appendStreamResult: import("../src/slack/client").DeliveryResult | null = null;
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
      .map((chunk) => {
        const c = chunk as { type?: unknown; text?: unknown };
        return c && typeof c === "object" && c.type === "markdown_text" ? String(c.text ?? "") : "";
      })
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
    setThreadStatus: async (s) => {
      rec.threadStatuses.push(s);
      return { ok: true };
    },
    startStream: async (s) => {
      if (startStreamResult) return startStreamResult;
      rec.streams.push({
        op: "start",
        channel: s.channel,
        threadTs: s.threadTs,
        mode: s.taskDisplayMode,
        recipientTeamId: s.recipientTeamId,
        recipientUserId: s.recipientUserId,
        chunks: s.chunks,
      });
      return { ok: true, ts: `${tsSeq++}.1` };
    },
    appendStream: async (s) => {
      if (appendStreamResult) return appendStreamResult;
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

async function replaySlackInboxClaim(claim: SlackInboxClaim): Promise<SlackInboxOutcome> {
  const identity = await verifySlackInboxIdentity(claim.payload);
  if (identity.status === "ignored") return { status: "completed" };
  if (identity.status === "rebound") return { status: "permanent", error: identity.error };
  const outcome = await handleSlackEvent(claim.payload.envelope, {
    identity,
    stagedAttachmentIds: claim.payload.stagedAttachmentIds,
    checkpointStagedAttachmentIds: claim.checkpointStagedAttachmentIds,
  });
  if (
    outcome.status === "accepted" ||
    outcome.status === "replayed" ||
    outcome.status === "permanent_noop"
  ) {
    return { status: "completed" };
  }
  if (outcome.status === "waiting_for_root") return { status: "waiting_for_root" };
  return { status: "retryable_unavailable", error: outcome.reason };
}

function restartSlackInboxPumpForTest(): void {
  startSlackInboxPump(replaySlackInboxClaim);
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

  test("a verified HTTP event is not ACKed when inbox persistence fails", async () => {
    const marker = uid("persist-fail");
    setSlackInboxPersisterForTest(async () => {
      throw new Error("synthetic inbox outage");
    });
    try {
      const res = await postSlack(eventCallback({
        type: "app_mention",
        channel: `C${uid("ch")}`,
        user: "U-HUMAN",
        text: `<@${BOT}> ${marker}`,
        ts: `${uid("ts")}.1`,
      }));
      expect(res.status).toBe(503);
      expect(await findRunByPrompt(marker)).toBeNull();
    } finally {
      setSlackInboxPersisterForTest(null);
    }
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
    // The native stream body closes with the reply text (the summary for a
    // completed run, the failure line for a failed one).
    const done = await json<any>(`/api/runs/${run.id}`);
    expect(answer).toContain(done.body.summary);
    const stopped = rec.streams.find((s) => s.op === "stop" && s.channel === channel && s.threadTs === ts);
    // The root task card settles alongside (complete or error, never spinning).
    const runTask = (stopped?.chunks as any[]).find((c) => c.type === "task_update" && c.id === "run");
    expect(["complete", "error"]).toContain(runTask.status);
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
    const envelope = eventCallback({
      type: "message",
      channel: `C${uid("ch")}`,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `noise ${marker}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    const res = await postSlack(envelope);
    expect(res.status).toBe(200); // acknowledged...
    // ...but no run created (give any async work a beat to NOT happen).
    await new Promise((r) => setTimeout(r, 150));
    expect(await findRunByPrompt(`noise ${marker}`)).toBeNull();
    const [inbox] = await db.select().from(commands).where(eq(commands.id, slackInboxKey(envelope)));
    expect(inbox).toBeUndefined(); // pure envelope gate runs before persistence
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

  test("DM shimmer: free-text status set at accept and cleared when the run settles", async () => {
    const marker = uid("shimmertext");
    const channel = `D${uid("dm")}`;
    const ts = `${uid("ts")}.1`;
    await postSlack(
      eventCallback({ type: "message", channel, channel_type: "im", user: "U-HUMAN", text: `go ${marker}`, ts }),
    );
    await waitFor(async () => findRunByPrompt(`go ${marker}`));
    // Cleared (empty status) once the run settles - durably, from finalize.
    await waitFor(
      async () => rec.threadStatuses.some((s) => s.channel === channel && s.status === "") || null,
      { timeoutMs: 14_000 },
    );
    const mine = rec.threadStatuses.filter((s) => s.channel === channel && s.threadTs === ts);
    expect(mine[0]?.status).toBe("is thinking...");
    expect(mine[mine.length - 1]?.status).toBe("");
  });

  test("a channel thread never gets the DM-only free-text status", async () => {
    const marker = uid("noshimmer");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    await postSlack(
      eventCallback({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> run ${marker}`, ts }),
    );
    await waitFor(async () => findRunByPrompt(`run ${marker}`));
    await waitFor(async () => finalAnswerFor(channel, ts), { timeoutMs: 14_000 });
    expect(rec.threadStatuses.some((s) => s.channel === channel)).toBe(false);
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

  /** Enqueue the run's native stream start (timeline mode, wire-shape chunks). */
  async function startNativeStream(t: { runId: string; channel: string; ts: string }, title: string): Promise<void> {
    const card = buildRunCard({ title, phase: "queued", model: "m", repoSpecs: [], webUrl: "https://x/session/1" });
    await enqueueStartStream({
      idempotencyKey: `slack-stream:start:${TEAM}:${t.runId}`,
      teamId: TEAM,
      channel: t.channel,
      threadTs: t.ts,
      runId: t.runId,
      taskDisplayMode: "timeline",
      chunks: openingStreamChunks(title),
      recipientTeamId: TEAM,
      recipientUserId: "U-HUMAN",
      fallbackBlocks: card.blocks,
      fallbackText: card.text,
    });
  }

  test("start_stream sends timeline mode, recipient identity, and FLAT task chunks", async () => {
    const t = await rootThread("wire shapes");
    await startNativeStream(t, "wire shapes");
    const started = await waitFor(async () =>
      rec.streams.find((s) => s.op === "start" && s.channel === t.channel) ?? null,
    );
    expect(started.mode).toBe("timeline");
    expect(started.recipientTeamId).toBe(TEAM);
    expect(started.recipientUserId).toBe("U-HUMAN");
    expect(started.chunks?.[0]).toEqual({
      type: "task_update",
      id: "run",
      title: "wire shapes",
      status: "in_progress",
    });
  });

  test("a start_stream API error falls back ONCE to the Block Kit card (no retry storm)", async () => {
    const t = await rootThread("stream unavailable");
    startStreamResult = { ok: false, class: "transient", message: "feature_not_enabled" };
    try {
      await startNativeStream(t, "stream unavailable");
      // The SAME delivery attempt posts the card fallback and settles the row.
      const posted = await waitFor(async () =>
        rec.messages.find((m) => m.channel === t.channel && m.blocks) ?? null,
      );
      expect(posted.threadTs).toBe(t.ts);
      const row = await getSlackOutbox(`slack-stream:start:${TEAM}:${t.runId}`);
      expect(row?.state).toBe("delivered");
      expect(row?.attemptCount).toBe(0); // never re-attempted
      const response = await findSlackRunResponse(t.runId);
      expect(response?.nativeStreamTs).toBeNull();
      expect(response?.fallbackMessageTs).toBeTruthy();
    } finally {
      startStreamResult = null;
    }
  });

  test("narration appends fence on their offset and the stop appends ONLY the tail", async () => {
    const t = await rootThread("narration tail");
    await startNativeStream(t, "narration tail");
    await waitFor(async () => ((await findSlackRunResponse(t.runId))?.nativeStreamTs ? true : null));

    const card = buildRunCard({ title: "narration tail", phase: "running", model: "m", repoSpecs: [], webUrl: "https://x/session/1" });
    const append = (seq: number, text: string, offset: number) =>
      enqueueAppendStream({
        idempotencyKey: `slack-stream:text:${TEAM}:${t.runId}:${seq}`,
        teamId: TEAM,
        channel: t.channel,
        threadTs: t.ts,
        runId: t.runId,
        chunks: markdownChunksFor(text),
        narrationOffset: offset,
        fallbackBlocks: card.blocks,
        fallbackText: card.text,
      });
    // OUT OF ORDER on purpose: the second segment lands first and must wait on
    // the offset fence until the first is accepted.
    await append(2, "world", 6);
    await append(1, "Hello ", 0);
    await waitFor(async () => {
      kickSlackOutbox(); // the test relay never ticks; drive retry passes
      const response = await findSlackRunResponse(t.runId);
      return response?.streamedChars === 11 ? true : null;
    });

    // The live narration buffer carries the full reply; the stop appends only
    // the un-streamed tail ("!") plus no closing (the reply was streamed).
    turnStream.publish(t.runId, "Hello world!");
    await finalizeRun(t.runId, "completed", "Hello world!", 1);
    const stopped = await waitFor(async () =>
      rec.streams.find((s) => s.op === "stop" && s.channel === t.channel) ?? null,
    );
    expect(finalAnswerFor(t.channel, t.ts)).toBe("!");
    // The native-stop card stays chrome-only: linked title, no answer section.
    const sections = (stopped.blocks as any[]).filter((b) => b.type === "section");
    expect(sections).toHaveLength(1);
    expect(sections[0].text.text).toContain("narration tail");
    expect(sections[0].text.text).not.toContain("Hello world!");
  });

  test("an append API error disables the native stream without stray posts", async () => {
    const t = await rootThread("append dies");
    await startNativeStream(t, "append dies");
    await waitFor(async () => ((await findSlackRunResponse(t.runId))?.nativeStreamTs ? true : null));

    appendStreamResult = { ok: false, class: "permanent", message: "message_not_in_streaming_state" };
    const messagesBefore = rec.messages.length;
    try {
      const card = buildRunCard({ title: "append dies", phase: "running", model: "m", repoSpecs: [], webUrl: "https://x/session/1" });
      await enqueueAppendStream({
        idempotencyKey: `slack-stream:step:${TEAM}:${t.runId}:s1`,
        teamId: TEAM,
        channel: t.channel,
        threadTs: t.ts,
        runId: t.runId,
        chunks: [runningTaskChunk({ id: "s1", label: "working" })],
        fallbackBlocks: card.blocks,
        fallbackText: card.text,
      });
      await waitFor(async () => {
        const response = await findSlackRunResponse(t.runId);
        return response && response.nativeStreamTs === null ? true : null;
      });
      const row = await getSlackOutbox(`slack-stream:step:${TEAM}:${t.runId}:s1`);
      expect(row?.state).toBe("delivered"); // dropped progress, not a storm
      expect(rec.messages.length).toBe(messagesBefore); // and no stray surfaces
    } finally {
      appendStreamResult = null;
    }
  });

  test("set_thread_status delivers once per idempotency key (replay-safe)", async () => {
    const marker = uid("shimmer");
    const channel = `D${uid("dm")}`;
    const ts = `${uid("ts")}.1`;
    const entry = {
      idempotencyKey: `slack-thread-status:step:${TEAM}:${marker}`,
      teamId: TEAM,
      channel,
      threadTs: ts,
      status: `is working: ${marker}`,
    };
    await enqueueThreadStatus(entry);
    await enqueueThreadStatus(entry); // replay collapses on the key
    await waitFor(async () =>
      rec.threadStatuses.some((s) => s.status === `is working: ${marker}`) || null,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(rec.threadStatuses.filter((s) => s.status === `is working: ${marker}`)).toHaveLength(1);
  });
});

describe("slack durable inbox", () => {
  test("persists one duplicate event while closed and drains it once after restart/open", async () => {
    await stopSlackInboxPumpForTest();
    const operationId = `slack-deferred-test:${crypto.randomUUID()}`;
    const marker = uid("deferred");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const envelope = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> queued ${marker}`,
      ts,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);

    await setRunAdmission({
      open: false,
      operationId,
      actor: "test",
      reason: "Slack deployment deferral test",
    });
    try {
      expect((await postSlack(envelope)).status).toBe(200);
      resetSlackDeduperForTest();
      expect((await postSlack(envelope)).status).toBe(200);

      const inbox = await waitFor(async () => {
        const rows = await db
          .select()
          .from(commands)
          .where(eq(commands.id, inboxKey));
        return rows.length > 0 ? rows : null;
      });
      expect(inbox).toHaveLength(1);
      expect(inbox[0]!.kind).toBe(SLACK_INBOX_EVENT);
      expect(inbox[0]!.state).toBe("queued");
      expect(inbox[0]!.orgId).toBe(DEV_ORG_ID);
      expect(inbox[0]!.actorId).toBe(DEV_USER_ID);
      expect(await findRunByPrompt(`queued ${marker}`)).toBeNull();

      restartSlackInboxPumpForTest();
      await waitFor(async () => {
        const rows = await db
          .select({ payload: slackOutbox.payload })
          .from(slackOutbox)
          .where(eq(
            slackOutbox.idempotencyKey,
            `slack-admission-queued:${TEAM}:${channel}:${ts}`,
          ));
        return rows[0] ?? null;
      });
      await waitFor(async () => {
        const [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
        return row?.state === "queued" && row.attemptCount === 0 ? row : null;
      });
      await stopSlackInboxPumpForTest();
      const [delayed] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      const defer = (JSON.parse(delayed.payload!) as {
        defer: { reason: string; nextAttemptAt: string };
      }).defer;
      expect(defer.reason).toBe("run_admission_closed");
      expect(Date.parse(defer.nextAttemptAt)).toBeGreaterThan(Date.now());
      expect(await processSlackInbox(replaySlackInboxClaim)).toMatchObject({ claimed: 0 });
      expect(await findRunByPrompt(`queued ${marker}`)).toBeNull();

      // Simulate the deployment restart: the inbox row remains authoritative.
      await setRunAdmission({
        open: true,
        operationId,
        actor: "test",
        reason: "deployment complete",
      });
      restartSlackInboxPumpForTest();
      await waitFor(async () => findRunByPrompt(`queued ${marker}`));

      resetSlackDeduperForTest();
      expect((await postSlack(envelope)).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
      expect(body.runs.filter((run) => run.prompt === `queued ${marker}`)).toHaveLength(1);
      const [completed] = await db
        .select({ state: commands.state, attemptCount: commands.attemptCount })
        .from(commands)
        .where(eq(commands.id, inboxKey));
      expect(completed).toEqual({ state: "completed", attemptCount: 1 });
      const queuedNotices = await db
        .select({ payload: slackOutbox.payload })
        .from(slackOutbox)
        .where(eq(
          slackOutbox.idempotencyKey,
          `slack-admission-queued:${TEAM}:${channel}:${ts}`,
        ));
      expect(queuedNotices).toHaveLength(1);
      expect(queuedNotices[0]!.payload).toContain("start automatically");
      expect(
        rec.messages.some(
          (message) => message.channel === channel && message.text.includes("Retry this message"),
        ),
      ).toBe(false);
    } finally {
      await setRunAdmission({
        open: true,
        operationId,
        actor: "test",
        reason: "test cleanup",
      });
      restartSlackInboxPumpForTest();
    }
  });

  test("fails closed when the persisted sender binding changes before replay", async () => {
    await stopSlackInboxPumpForTest();
    const marker = uid("rebind");
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> rebind ${marker}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    try {
      expect((await postSlack(envelope)).status).toBe(200);
      await db.execute(sql`delete from slack_users where team_id = ${TEAM} and slack_user_id = 'U-HUMAN'`);
      restartSlackInboxPumpForTest();
      const failed = await waitFor(async () => {
        const [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
        return row?.state === "failed" ? row : null;
      });
      expect(failed.error).toBe("slack_sender_binding_changed");
      expect(await findRunByPrompt(`rebind ${marker}`)).toBeNull();
    } finally {
      await upsertSlackUser({
        teamId: TEAM,
        slackUserId: "U-HUMAN",
        orgId: DEV_ORG_ID,
        userId: DEV_USER_ID,
      });
      restartSlackInboxPumpForTest();
    }
  });

  test("a stale worker cannot complete a claim reclaimed by a new worker", async () => {
    await stopSlackInboxPumpForTest();
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> fence ${uid("fence")}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    await persistSlackInboxEvent(envelope);
    let entered!: () => void;
    const claimed = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const staleWorker = processSlackInbox(async () => {
      entered();
      await blocked;
      return { status: "completed" };
    });
    await claimed;
    await db
      .update(commands)
      .set({ updatedAt: new Date(Date.now() - 31_000) })
      .where(eq(commands.id, inboxKey));
    expect(await processSlackInbox(async () => ({ status: "completed" }))).toMatchObject({
      claimed: 1,
      completed: 1,
    });
    release();
    expect(await staleWorker).toMatchObject({ claimed: 1, completed: 0 });
    const [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
    expect(row.state).toBe("completed");
    restartSlackInboxPumpForTest();
  });

  test("the eighth processing error permanently fails the inbox row", async () => {
    await stopSlackInboxPumpForTest();
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> retry cap ${uid("cap")}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    await persistSlackInboxEvent(envelope);
    for (let attempt = 1; attempt <= 8; attempt++) {
      await processSlackInbox(async () => { throw new Error(`failure ${attempt}`); });
    }
    const [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
    expect(row).toMatchObject({ state: "failed", attemptCount: 8, error: "failure 8" });
    restartSlackInboxPumpForTest();
  });

  test("retryable unavailability is delayed and resumes when due", async () => {
    await stopSlackInboxPumpForTest();
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> unavailable ${uid("unavailable")}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    try {
      await persistSlackInboxEvent(envelope);
      await processSlackInbox(async (claim) =>
        slackInboxKey(claim.payload.envelope) === inboxKey
          ? { status: "retryable_unavailable", error: "provider_unavailable" }
          : replaySlackInboxClaim(claim));
      let [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      const deferred = (JSON.parse(row.payload!) as {
        defer: { count: number; reason: string; nextAttemptAt: string };
      }).defer;
      expect(deferred).toMatchObject({ count: 1, reason: "provider_unavailable" });
      expect(Date.parse(deferred.nextAttemptAt)).toBeGreaterThan(Date.now());

      await processSlackInbox(async () => ({ status: "completed" }));
      [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(row.state).toBe("queued");
      expect(row.attemptCount).toBe(0);

      const payload = JSON.parse(row.payload!) as SlackInboxPayload;
      await db.update(commands).set({
        payload: JSON.stringify({
          ...payload,
          defer: { ...payload.defer!, nextAttemptAt: new Date(Date.now() - 1_000).toISOString() },
        }),
      }).where(eq(commands.id, inboxKey));
      await processSlackInbox(async (claim) =>
        slackInboxKey(claim.payload.envelope) === inboxKey
          ? { status: "completed" }
          : replaySlackInboxClaim(claim));
      [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(row.state).toBe("completed");
    } finally {
      restartSlackInboxPumpForTest();
    }
  });

  test("an unrelated reply probation expires once into a retention-eligible no-op", async () => {
    await stopSlackInboxPumpForTest();
    const envelope = eventCallback({
      type: "message",
      channel: `C${uid("ch")}`,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `unrelated ${uid("expire")}`,
      ts: `${uid("ts")}.1`,
      thread_ts: `${uid("unrelated-root")}.0`,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    try {
      expect((await postSlack(envelope)).status).toBe(200);
      const [queued] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      const payload = JSON.parse(queued.payload!) as SlackInboxPayload;
      expect(payload.defer).toMatchObject({ reason: "awaiting_root_commit", count: 0 });
      expect(await processSlackInbox(replaySlackInboxClaim)).toMatchObject({ claimed: 0 });

      await db.update(commands).set({
        payload: JSON.stringify({
          ...payload,
          defer: {
            ...payload.defer!,
            count: 11,
            firstDeferredAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
            nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
          },
        }),
      }).where(eq(commands.id, inboxKey));
      expect(await processSlackInbox(replaySlackInboxClaim)).toMatchObject({
        claimed: 1,
        completed: 1,
        requeued: 0,
      });
      const [completed] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(completed.state).toBe("completed");
      expect(completed.error).toBe("permanent_noop:awaiting_root_commit_expired");
      expect(await processSlackInbox(replaySlackInboxClaim)).toMatchObject({ claimed: 0 });
      expect((await postSlack(envelope)).status).toBe(200);
      const [retried] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(retried.state).toBe("completed");
      expect(await processSlackInbox(replaySlackInboxClaim)).toMatchObject({ claimed: 0 });
    } finally {
      restartSlackInboxPumpForTest();
    }
  });

  test("fails an exhausted stale dispatch left by a crashed process", async () => {
    await stopSlackInboxPumpForTest();
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> exhausted crash ${uid("crash")}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    try {
      await persistSlackInboxEvent(envelope);
      await db
        .update(commands)
        .set({
          state: "dispatched",
          attemptCount: 8,
          error: "dead-worker-token",
          updatedAt: new Date(Date.now() - 31_000),
        })
        .where(eq(commands.id, inboxKey));
      let invoked = false;
      expect(await processSlackInbox(async () => {
        invoked = true;
        return { status: "completed" };
      })).toMatchObject({ claimed: 0, failed: 1 });
      expect(invoked).toBe(false);
      const [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(row).toMatchObject({
        state: "failed",
        attemptCount: 8,
        error: "retry_exhausted_after_restart",
      });
    } finally {
      restartSlackInboxPumpForTest();
    }
  });

  test("reply persists before the root INSERT commits, then attaches exactly once", async () => {
    await stopSlackInboxPumpForTest();
    const marker = uid("root-commit-race");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("root")}.1`;
    const replyTs = `${uid("reply")}.2`;
    const root = eventCallback({
      type: "app_mention",
      channel,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `<@${BOT}> race root ${marker}`,
      ts: rootTs,
    }) as SlackEnvelope;
    const reply = eventCallback({
      type: "message",
      channel,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `race reply ${marker}`,
      ts: replyTs,
      thread_ts: rootTs,
    }) as SlackEnvelope;
    let rootReachedInsert!: () => void;
    const rootInsertBlocked = new Promise<void>((resolve) => { rootReachedInsert = resolve; });
    let releaseRootInsert!: () => void;
    const rootInsertRelease = new Promise<void>((resolve) => { releaseRootInsert = resolve; });
    let rootReleased = false;
    setSlackInboxBeforePersistInsertForTest(async (envelope) => {
      if (slackInboxKey(envelope) !== slackInboxKey(root)) return;
      rootReachedInsert();
      await rootInsertRelease;
    });
    try {
      const rootRequest = postSlack(root);
      await rootInsertBlocked;

      const replyResponse = await postSlack(reply);
      expect(replyResponse.status).toBe(200);
      const [persistedReply] = await db
        .select()
        .from(commands)
        .where(eq(commands.id, slackInboxKey(reply)));
      expect(persistedReply).toMatchObject({
        state: "queued",
        threadId: slackInboxThreadId(reply),
      });
      expect((JSON.parse(persistedReply.payload!) as SlackInboxPayload).defer).toMatchObject({
        reason: "awaiting_root_commit",
        count: 0,
      });
      const [notYetCommittedRoot] = await db
        .select({ id: commands.id })
        .from(commands)
        .where(eq(commands.id, slackInboxKey(root)));
      expect(notYetCommittedRoot).toBeUndefined();

      rootReleased = true;
      releaseRootInsert();
      expect((await rootRequest).status).toBe(200);
      const [persistedRoot] = await db
        .select()
        .from(commands)
        .where(eq(commands.id, slackInboxKey(root)));
      expect(persistedRoot.threadId).toBe(slackInboxThreadId(root));

      restartSlackInboxPumpForTest();
      const rootRun = await waitFor(async () => findRunByPrompt(`race root ${marker}`));
      const replyRun = await waitFor(async () => findRunByPrompt(`race reply ${marker}`));
      expect(replyRun.parent_run_id).toBe(rootRun.id);
      const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
      expect(body.runs.filter((run) => run.prompt === `race reply ${marker}`)).toHaveLength(1);
      const completedReply = await waitFor(async () => {
        const [row] = await db
          .select({ state: commands.state })
          .from(commands)
          .where(eq(commands.id, slackInboxKey(reply)));
        return row?.state === "completed" ? row : null;
      });
      expect(completedReply.state).toBe("completed");
    } finally {
      setSlackInboxBeforePersistInsertForTest(null);
      if (!rootReleased) releaseRootInsert();
      restartSlackInboxPumpForTest();
    }
  });

  test("Slack root-thread lookup uses the existing commands thread-state index", async () => {
    await stopSlackInboxPumpForTest();
    const prefix = `slack-plan-${crypto.randomUUID()}`;
    const targetThread = `${prefix}-target`;
    try {
      await db.execute(sql`
        insert into commands (id, kind, thread_id, state, attempt_count, created_at, updated_at)
        select
          ${prefix} || '-' || g::text,
          ${SLACK_INBOX_EVENT},
          case when g = 1 then ${targetThread} else ${prefix} || '-thread-' || g::text end,
          'queued',
          0,
          now() - (g * interval '1 millisecond'),
          now()
        from generate_series(1, 4000) as g`);
      await db.execute(sql`analyze commands`);
      const plan = await db.execute(sql`
        explain (format text)
        select id from commands
        where thread_id = ${targetThread}
          and state in ('queued', 'dispatched')
        order by created_at asc
        limit 1`);
      const rendered = plan
        .map((row) => String((row as Record<string, unknown>)["QUERY PLAN"] ?? ""))
        .join("\n");
      expect(rendered).toContain("idx_commands_thread_state");
    } finally {
      await db.execute(sql`delete from commands where id like ${`${prefix}%`}`);
      restartSlackInboxPumpForTest();
    }
  });

  test("closed root then reply both drain after admission reopens", async () => {
    await stopSlackInboxPumpForTest();
    const operationId = `slack-root-reply:${crypto.randomUUID()}`;
    const marker = uid("closed-thread");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("root")}.1`;
    const replyTs = `${uid("reply")}.2`;
    const root = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> root ${marker}`,
      ts: rootTs,
    }) as SlackEnvelope;
    const reply = eventCallback({
      type: "message",
      channel,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `reply ${marker}`,
      ts: replyTs,
      thread_ts: rootTs,
    }) as SlackEnvelope;
    await setRunAdmission({
      open: false,
      operationId,
      actor: "test",
      reason: "closed root/reply ordering proof",
    });
    try {
      expect((await postSlack(root)).status).toBe(200);
      expect((await postSlack(reply)).status).toBe(200);
      restartSlackInboxPumpForTest();
      await waitFor(async () => {
        const rows = await db.select().from(commands).where(sql`${commands.id} in (${slackInboxKey(root)}, ${slackInboxKey(reply)})`);
        return rows.length === 2 && rows.every((row) => row.state === "queued") ? rows : null;
      });
      expect(await findRunByPrompt(`root ${marker}`)).toBeNull();
      expect(await findRunByPrompt(`reply ${marker}`)).toBeNull();
      await setRunAdmission({
        open: true,
        operationId,
        actor: "test",
        reason: "reopen root/reply ordering proof",
      });
      const rootRun = await waitFor(async () => findRunByPrompt(`root ${marker}`));
      const replyRun = await waitFor(async () => findRunByPrompt(`reply ${marker}`));
      expect(replyRun.parent_run_id).toBe(rootRun.id);
      expect(replyRun.thread_id).toBe(rootRun.id);
    } finally {
      await setRunAdmission({
        open: true,
        operationId,
        actor: "test",
        reason: "test cleanup",
      });
      restartSlackInboxPumpForTest();
    }
  });

  test("a reply processed before its pending root waits durably then attaches", async () => {
    await stopSlackInboxPumpForTest();
    const marker = uid("reverse-thread");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("root")}.1`;
    const reply = eventCallback({
      type: "message",
      channel,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `reply first ${marker}`,
      ts: `${uid("reply")}.2`,
      thread_ts: rootTs,
    }) as SlackEnvelope;
    const root = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> root later ${marker}`,
      ts: rootTs,
    }) as SlackEnvelope;
    try {
      expect((await postSlack(root)).status).toBe(200);
      expect((await postSlack(reply)).status).toBe(200);
      // The root is durably pending, but force the reply to be claimed first.
      await db
        .update(commands)
        .set({ createdAt: new Date(Date.now() - 1_000) })
        .where(eq(commands.id, slackInboxKey(reply)));
      restartSlackInboxPumpForTest();
      const rootRun = await waitFor(async () => findRunByPrompt(`root later ${marker}`));
      const replyRun = await waitFor(async () => findRunByPrompt(`reply first ${marker}`));
      expect(replyRun.parent_run_id).toBe(rootRun.id);
      const replyInbox = await waitFor(async () => {
        const [row] = await db.select().from(commands).where(eq(commands.id, slackInboxKey(reply)));
        return row?.state === "completed" ? row : null;
      });
      expect(replyInbox.attemptCount).toBe(1);
    } finally {
      restartSlackInboxPumpForTest();
    }
  });

  test("a healthy claim heartbeat prevents reclaim after more than 30 seconds", async () => {
    await stopSlackInboxPumpForTest();
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> long healthy claim ${uid("lease")}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    try {
      await persistSlackInboxEvent(envelope);
      let entered!: () => void;
      const claimed = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const firstReplica = processSlackInbox(async (claim) => {
        await claim.checkpointStagedAttachmentIds(["upload-long-running"]);
        entered();
        await blocked;
        return { status: "completed" };
      });
      await claimed;
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      expect(await processSlackInbox(async () => ({ status: "completed" }))).toMatchObject({
        claimed: 0,
      });
      const [leased] = await db
        .select({ payload: commands.payload, state: commands.state })
        .from(commands)
        .where(eq(commands.id, slackInboxKey(envelope)));
      expect(leased.state).toBe("dispatched");
      expect(leased.payload).toContain("upload-long-running");
      release();
      expect(await firstReplica).toMatchObject({ claimed: 1, completed: 1 });
    } finally {
      restartSlackInboxPumpForTest();
    }
  }, 45_000);

  test("canonical storage drops unknown fields and terminal retention redacts then deletes", async () => {
    await stopSlackInboxPumpForTest();
    const secret = `provider-secret-${uid("secret")}`;
    const envelope = {
      ...eventCallback({
        type: "app_mention",
        channel: `C${uid("ch")}`,
        user: "U-HUMAN",
        text: `<@${BOT}> retain ${uid("retain")}`,
        ts: `${uid("ts")}.1`,
        hidden_provider_field: secret,
        files: [{
          id: `F${uid("f")}`,
          name: "proof.txt",
          size: 4,
          mimetype: "text/plain",
          url_private_download: `https://files.slack.com/${secret}`,
          hidden_file_field: secret,
        }],
      }),
      hidden_envelope_field: secret,
    } as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    try {
      await persistSlackInboxEvent(envelope);
      let [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(row.payload).not.toContain("hidden_provider_field");
      expect(row.payload).not.toContain("hidden_file_field");
      expect(row.payload).not.toContain("hidden_envelope_field");
      expect(row.payload).toContain(secret); // allowlisted file URL is needed until terminal.

      await db
        .update(commands)
        .set({ state: "completed", createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
        .where(eq(commands.id, inboxKey));
      expect(await maintainSlackInboxRetention()).toMatchObject({ redacted: 1 });
      [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(row.payload).toContain('"redacted"');
      expect(row.payload).not.toContain(secret);

      await db
        .update(commands)
        .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
        .where(eq(commands.id, inboxKey));
      expect(await maintainSlackInboxRetention()).toMatchObject({ deleted: 1 });
      const [deleted] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(deleted).toBeUndefined();
    } finally {
      restartSlackInboxPumpForTest();
    }
  });
});

// Durable inbound dedupe: the command lane is keyed by the Slack event identity
// (slack-event:<team>:<event_id>, channel:ts fallback), so a duplicate that
// OUTLIVES a process restart or cross-lane double delivery and still collapses
// to one run through the inbox + run-command identities.
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
    const otherOrgId = `org-other-${uid("org")}`;
    await createRun({
      id: rootRunId,
      prompt: `legacy cross root ${marker}`,
      model: "claude-opus-5",
      engine: "mock",
      orgId: otherOrgId,
      userId: null,
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
      orgId: otherOrgId,
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

// Durable-ack ingress: the events route commits the small inbox row before its
// 200; slower staging and run acceptance still happen behind that ACK.
describe("slack durable-ack ingress", () => {
  test("the 200 does not wait for event processing (slow attachment staging)", async () => {
    // A 600ms attachment download would blow a synchronous handler way past
    // this assertion; durable-ack returns while staging is still in flight.
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

    await dispatchSocketFrame(raw, (id) => acked.push(id), () => {});

    expect(acked).toEqual([envelopeId]); // acked after inbox commit, before processing

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

  test("a socket event is not ACKed when inbox persistence fails", async () => {
    const acked: string[] = [];
    const { raw } = socketFrame(eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> persist failure`,
      ts: `${uid("ts")}.1`,
    }));
    setSlackInboxPersisterForTest(async () => { throw new Error("synthetic inbox outage"); });
    try {
      await dispatchSocketFrame(raw, (id) => acked.push(id), () => {});
      expect(acked).toEqual([]);
    } finally {
      setSlackInboxPersisterForTest(null);
    }
  });

  test("hello is a no-op; disconnect asks us to close", async () => {
    let closed = 0;
    await dispatchSocketFrame(JSON.stringify({ type: "hello" }), () => {}, () => closed++);
    expect(closed).toBe(0);
    await dispatchSocketFrame(JSON.stringify({ type: "disconnect" }), () => {}, () => closed++);
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
    const envelope = eventCallback(
      {
        type: "app_mention",
        channel: `C${uid("ch")}`,
        user: "U-HUMAN",
        text: `<@${BOT}> hi ${marker}`,
        ts: `${uid("ts")}.1`,
      },
      `T-UNMAPPED-${uid("t")}`,
    ) as SlackEnvelope;
    const res = await postSlack(envelope);
    expect(res.status).toBe(200); // acknowledged to Slack...
    await new Promise((r) => setTimeout(r, 150));
    expect(await findRunByPrompt(`hi ${marker}`)).toBeNull(); // ...but no run
    const inbox = await waitFor(async () => {
      const [row] = await db.select().from(commands).where(eq(commands.id, slackInboxKey(envelope)));
      return row?.state === "completed" ? row : null;
    });
    expect(inbox.state).toBe("completed");
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

  test("a close after file staging checkpoints IDs and replay does not redownload", async () => {
    await stopSlackInboxPumpForTest();
    const operationId = `slack-stage-reclose:${crypto.randomUUID()}`;
    const marker = uid("reclose");
    const fileName = `${marker}.txt`;
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> summarize ${marker}`,
      ts: `${uid("ts")}.1`,
      files: [slackFile(fileName)],
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    const downloadsBefore = downloaded.length;
    let closeAfterCheckpoint = true;
    try {
      expect((await postSlack(envelope)).status).toBe(200);
      await db
        .update(commands)
        .set({ createdAt: new Date(0) })
        .where(eq(commands.id, inboxKey));
      const first = await processSlackInbox(async (claim) => {
        const identity = await verifySlackInboxIdentity(claim.payload);
        if (identity.status !== "verified") return { status: "completed" };
        const outcome = await handleSlackEvent(claim.payload.envelope, {
          identity,
          stagedAttachmentIds: claim.payload.stagedAttachmentIds,
          checkpointStagedAttachmentIds: async (ids) => {
            await claim.checkpointStagedAttachmentIds(ids);
            if (closeAfterCheckpoint) {
              closeAfterCheckpoint = false;
              await setRunAdmission({
                open: false,
                operationId,
                actor: "test",
                reason: "close after Slack upload staging",
              });
            }
          },
        });
        return outcome.status === "retryable_unavailable"
          ? { status: "retryable_unavailable", error: outcome.reason }
          : { status: "completed" };
      });
      expect(first.requeued).toBeGreaterThanOrEqual(1);
      expect(downloaded.length - downloadsBefore).toBe(1);
      const [queued] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(queued.state).toBe("queued");
      expect((JSON.parse(queued.payload!) as { stagedAttachmentIds: string[] }).stagedAttachmentIds).toHaveLength(1);

      await setRunAdmission({
        open: true,
        operationId,
        actor: "test",
        reason: "reopen after checkpoint proof",
      });
      restartSlackInboxPumpForTest();
      const run = await waitFor(async () => findRunByPrompt(`summarize ${marker}`));
      expect(run.id).toBeTruthy();
      expect(downloaded.length - downloadsBefore).toBe(1);
      const [upload] = await uploadsByName(fileName);
      expect(upload.runId).toBe(run.id);
    } finally {
      await setRunAdmission({
        open: true,
        operationId,
        actor: "test",
        reason: "test cleanup",
      });
      restartSlackInboxPumpForTest();
    }
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
    // Wait for the CLAIMED upload, not merely the row: the files-only path
    // stages the upload before the synthesized run claims it, so a slow runner
    // can observe the legitimate runId=NULL window between the two.
    const upload = await waitFor(async () => {
      const row = (await uploadsByName(fileName))[0];
      return row?.runId ? row : null;
    });
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
