/**
 * slack_upload gateway tool (item 6) — deliver a run-produced artifact back to
 * the Slack thread. Fully in-process: the sandbox download is stubbed
 * (setSandboxDownloaderForTest) and delivery is driven through the durable
 * outbox with a recording client, so nothing hits Daytona or Slack.
 *
 * Proves: gating (non-Slack run refused), the happy path (download -> stage ->
 * enqueue upload_file -> outbox delivers with the right bytes -> staged file
 * cleaned up), and the size cap (oversized file refused before staging).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { slackOutbox } from "../src/db/schema";
import { createRun, setRunSandbox } from "../src/runs/repo";
import { linkSlackThread } from "../src/slack/repo";
import { setSandboxDownloaderForTest } from "../src/slack/sandbox-file";
import { processDue, stopSlackOutboxRelay } from "../src/slack/outbox";
import { executeSlackTool } from "../src/knowledge/gateway/slack-tools";
import { handleMcpMessage } from "../src/knowledge/gateway/mcp";
import type { SlackClient } from "../src/slack/client";
import type { ToolTokenClaims } from "../src/knowledge/gateway/token";
import "./helpers"; // side-effect: imports src/index → migrate + seed

const ORG = "org-skynet-dev";

function claimsFor(runId: string): ToolTokenClaims {
  return { orgId: ORG, userId: "u", threadId: runId, runId, exp: Date.now() + 60_000 };
}

/** A Slack-originated run: a run + a sandbox + a thread mapping on its own id. */
async function slackRunWithSandbox(prompt: string): Promise<{ runId: string; channel: string; ts: string }> {
  const runId = crypto.randomUUID();
  const channel = `C${runId.slice(0, 6)}`;
  const ts = `${runId.slice(0, 6)}.1`;
  await createRun({ id: runId, prompt, model: "claude-opus-5", engine: "mock", orgId: ORG, userId: null, parentRunId: null, threadId: runId });
  await setRunSandbox(runId, "sb-123");
  await linkSlackThread({ channel, threadTs: ts, rootRunId: runId, orgId: ORG });
  return { runId, channel, ts };
}

const text = (r: { content: Array<{ text: string }> }): string => r.content.map((c) => c.text).join("");

beforeAll(() => stopSlackOutboxRelay()); // drive processDue explicitly; no relay races
beforeEach(() => setSandboxDownloaderForTest(async () => ({ bytes: Buffer.from("hello world"), size: 11 })));
afterAll(() => setSandboxDownloaderForTest(null));

describe("slack_upload tool", () => {
  test("refuses a run that is not linked to a Slack thread", async () => {
    const runId = crypto.randomUUID();
    await createRun({ id: runId, prompt: "api run", model: "claude-opus-5", engine: "mock", orgId: ORG, userId: null, parentRunId: null, threadId: runId });
    await setRunSandbox(runId, "sb-x");
    const res = await executeSlackTool(claimsFor(runId), "slack_upload", { path: "out/x.txt" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("not linked to a Slack thread");
  });

  test("refuses when no `path` is given", async () => {
    const { runId } = await slackRunWithSandbox("need a path");
    const res = await executeSlackTool(claimsFor(runId), "slack_upload", {});
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("requires a `path`");
  });

  test("downloads, stages, durably enqueues, delivers with the right bytes, then cleans up", async () => {
    const { runId, channel, ts } = await slackRunWithSandbox("make a report");
    const res = await executeSlackTool(claimsFor(runId), "slack_upload", { path: "outputs/demo.txt", title: "Demo" });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain("Delivering demo.txt (11 bytes)");

    // A durable upload_file row was enqueued with the resolved thread + staged path.
    const [row] = await db
      .select()
      .from(slackOutbox)
      .where(eq(slackOutbox.kind, "upload_file"))
      .orderBy(desc(slackOutbox.createdAt))
      .limit(1);
    expect(row).toBeTruthy();
    const payload = JSON.parse(row!.payload) as { channel: string; threadTs?: string; filename: string; title?: string; stagedPath: string };
    expect(payload.channel).toBe(channel);
    expect(payload.threadTs).toBe(ts);
    expect(payload.filename).toBe("demo.txt");
    expect(payload.title).toBe("Demo");
    expect(await Bun.file(payload.stagedPath).exists()).toBe(true); // bytes staged on disk

    // The outbox delivers it, reading the staged bytes and calling uploadFile.
    const uploads: Array<{ channel: string; threadTs?: string; filename: string; bytes: Uint8Array }> = [];
    const recClient: SlackClient = {
      postMessage: async () => ({ ok: true }),
      addReaction: async () => ({ ok: true }),
      setAssistantStatus: async () => {},
      uploadFile: async (a) => {
        uploads.push(a);
        return { ok: true };
      },
    };
    await processDue(recClient);

    expect(uploads.length).toBe(1);
    expect(uploads[0]!.channel).toBe(channel);
    expect(uploads[0]!.threadTs).toBe(ts);
    expect(uploads[0]!.filename).toBe("demo.txt");
    expect(Buffer.from(uploads[0]!.bytes).toString()).toBe("hello world");
    // Staged bytes are removed once the row is delivered.
    expect(await Bun.file(payload.stagedPath).exists()).toBe(false);
  });

  test("refuses a file over the size cap (before staging)", async () => {
    setSandboxDownloaderForTest(async () => {
      throw new Error("file is 99999999 bytes, over the 52428800-byte limit");
    });
    const { runId } = await slackRunWithSandbox("too big");
    const res = await executeSlackTool(claimsFor(runId), "slack_upload", { path: "outputs/huge.bin" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("over the");
  });

  test("tools/list advertises slack_upload ONLY to a Slack-originated run", async () => {
    const listNames = async (runId: string): Promise<string[]> => {
      const res = await handleMcpMessage(claimsFor(runId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
      return (res!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    };

    const { runId: slackRunId } = await slackRunWithSandbox("slack run");
    expect(await listNames(slackRunId)).toContain("slack_upload");

    const plainId = crypto.randomUUID();
    await createRun({ id: plainId, prompt: "api run", model: "claude-opus-5", engine: "mock", orgId: ORG, userId: null, parentRunId: null, threadId: plainId });
    expect(await listNames(plainId)).not.toContain("slack_upload");
  });
});
