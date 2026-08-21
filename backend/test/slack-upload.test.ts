/**
 * slack_upload gateway tool (item 6) — deliver a run-produced artifact back to
 * the Slack thread. Fully in-process: the sandbox download is stubbed
 * (setSandboxDownloaderForTest) and delivery is driven through the durable
 * outbox with a recording client, so nothing hits Daytona or Slack.
 *
 * Proves: gating (non-Slack run refused), the happy path (one sandbox pull ->
 * shared artifact -> browser + Slack read the exact same bytes), artifact-id
 * reuse/idempotency, and the size cap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { providerEvents, slackOutbox } from "../src/db/schema";
import { createRun, setRunSandbox } from "../src/runs/repo";
import { linkSlackThread } from "../src/slack/repo";
import { setSandboxDownloaderForTest } from "../src/slack/sandbox-file";
import { processDue, stopSlackOutboxRelay } from "../src/slack/outbox";
import { setArtifactStorageForTest } from "../src/artifacts/storage";
import { executeArtifactTool } from "../src/knowledge/gateway/artifact-tools";
import { executeSlackTool } from "../src/knowledge/gateway/slack-tools";
import { handleMcpMessage } from "../src/knowledge/gateway/mcp";
import type { SlackClient } from "../src/slack/client";
import type { ToolTokenClaims } from "../src/knowledge/gateway/token";
import { fetchApi } from "./helpers";
import { InMemoryArtifactStorage } from "./in-memory-artifact-storage";

const ORG = "org-skynet-dev";
const TEAM = "T-SKYNET-DEV";
const storage = new InMemoryArtifactStorage();

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
  await linkSlackThread({ teamId: TEAM, channel, threadTs: ts, rootRunId: runId, orgId: ORG });
  return { runId, channel, ts };
}

const text = (r: { content: Array<{ text: string }> }): string => r.content.map((c) => c.text).join("");

beforeAll(() => {
  stopSlackOutboxRelay();
  setArtifactStorageForTest(storage);
}); // drive processDue explicitly; no relay races
beforeEach(() => setSandboxDownloaderForTest(async () => ({ bytes: Buffer.from("hello world"), size: 11 })));
afterAll(() => {
  setSandboxDownloaderForTest(null);
  setArtifactStorageForTest(null);
});

describe("slack_upload tool", () => {
  test("refuses a run that is not linked to a Slack thread", async () => {
    const runId = crypto.randomUUID();
    await createRun({ id: runId, prompt: "api run", model: "claude-opus-5", engine: "mock", orgId: ORG, userId: null, parentRunId: null, threadId: runId });
    await setRunSandbox(runId, "sb-x");
    const res = await executeSlackTool(claimsFor(runId), "slack_upload", {
      path: "/root/work/out/x.txt",
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("not linked to a Slack thread");
  });

  test("refuses when no `path` is given", async () => {
    const { runId } = await slackRunWithSandbox("need a path");
    const res = await executeSlackTool(claimsFor(runId), "slack_upload", {});
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("requires an `artifactId` or sandbox `path`");
  });

  test("one sandbox pull produces the exact browser and Slack bytes", async () => {
    const { runId, channel, ts } = await slackRunWithSandbox("make a report");
    const res = await executeSlackTool(claimsFor(runId), "slack_upload", {
      path: "/root/work/outputs/demo.txt",
      title: "Demo",
    });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain("Queued demo.txt (11 bytes)");

    const beforeDelivery = await db
      .select({ id: providerEvents.id })
      .from(providerEvents)
      .where(
        and(
          eq(providerEvents.runId, runId),
          eq(providerEvents.eventType, "artifact.delivered"),
        ),
      );
    expect(beforeDelivery).toHaveLength(0);

    // A durable upload_file row references shared artifact storage, not an
    // ephemeral Slack-only staging file.
    const [row] = await db
      .select()
      .from(slackOutbox)
      .where(eq(slackOutbox.kind, "upload_file"))
      .orderBy(desc(slackOutbox.createdAt))
      .limit(1);
    expect(row).toBeTruthy();
    if (!row) throw new Error("expected upload_file row");
    const payload = JSON.parse(row.payload) as {
      channel: string;
      threadTs?: string;
      filename: string;
      title?: string;
      artifactId: string;
      stagedPath?: string;
    };
    expect(payload.channel).toBe(channel);
    expect(payload.threadTs).toBe(ts);
    expect(payload.filename).toBe("demo.txt");
    expect(payload.title).toBe("Demo");
    expect(payload.artifactId).toBeTruthy();
    expect(payload.stagedPath).toBeUndefined();

    const browser = await fetchApi(`/api/artifacts/${payload.artifactId}/content`);
    expect(browser.status).toBe(200);
    expect(Buffer.from(await browser.arrayBuffer()).toString()).toBe("hello world");

    // The outbox resolves the same artifact id and calls Slack with exact bytes.
    const uploads: Array<{ channel: string; threadTs?: string; filename: string; bytes: Uint8Array }> = [];
    const recClient: SlackClient = {
      postMessage: async () => ({ ok: true }),
      updateMessage: async () => ({ ok: true }),
      addReaction: async () => ({ ok: true }),
      setSessionStatus: async () => ({ ok: true }),
      startStream: async () => ({ ok: true, ts: "stream.1" }),
      appendStream: async () => ({ ok: true }),
      stopStream: async () => ({ ok: true }),
      uploadFile: async (a) => {
        uploads.push(a);
        return { ok: true };
      },
    };
    await processDue(recClient);

    expect(uploads.length).toBe(1);
    const upload = uploads[0];
    if (!upload) throw new Error("expected one Slack upload");
    expect(upload.channel).toBe(channel);
    expect(upload.threadTs).toBe(ts);
    expect(upload.filename).toBe("demo.txt");
    expect(Buffer.from(upload.bytes).toString()).toBe("hello world");
    expect(storage.values.size).toBeGreaterThan(0); // durable after connector delivery

    const afterDelivery = await db
      .select({ id: providerEvents.id })
      .from(providerEvents)
      .where(
        and(
          eq(providerEvents.runId, runId),
          eq(providerEvents.eventType, "artifact.delivered"),
        ),
      );
    expect(afterDelivery).toHaveLength(1);
  });

  test("artifact id avoids a second sandbox pull and duplicate Slack delivery", async () => {
    const { runId } = await slackRunWithSandbox("publish once");
    const claims = claimsFor(runId);
    const published = await executeArtifactTool(claims, "artifact_publish", {
      path: "/root/work/outputs/report.txt",
    });
    const artifact = published.structuredContent?.artifact as { id?: unknown } | undefined;
    const artifactId = typeof artifact?.id === "string" ? artifact.id : "";
    expect(artifactId).toBeTruthy();

    setSandboxDownloaderForTest(async () => {
      throw new Error("a durable artifact must not be pulled twice");
    });
    const first = await executeSlackTool(claims, "slack_upload", { artifactId });
    const duplicate = await executeSlackTool(claims, "slack_upload", { artifactId });
    expect(first.isError).toBeUndefined();
    expect(duplicate.isError).toBeUndefined();

    const uploads: Uint8Array[] = [];
    const recClient: SlackClient = {
      postMessage: async () => ({ ok: true }),
      updateMessage: async () => ({ ok: true }),
      addReaction: async () => ({ ok: true }),
      setSessionStatus: async () => ({ ok: true }),
      startStream: async () => ({ ok: true, ts: "stream.1" }),
      appendStream: async () => ({ ok: true }),
      stopStream: async () => ({ ok: true }),
      uploadFile: async ({ bytes }) => {
        uploads.push(bytes);
        return { ok: true };
      },
    };
    await processDue(recClient);
    expect(uploads).toHaveLength(1);
    expect(Buffer.from(uploads[0] ?? []).toString()).toBe("hello world");
  });

  test("refuses a file over the size cap (before staging)", async () => {
    setSandboxDownloaderForTest(async () => {
      throw new Error("file is 99999999 bytes, over the 52428800-byte limit");
    });
    const { runId } = await slackRunWithSandbox("too big");
    const res = await executeSlackTool(claimsFor(runId), "slack_upload", {
      path: "/root/work/outputs/huge.bin",
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("over the");
  });

  test("tools/list advertises slack_upload ONLY to a Slack-originated run", async () => {
    const listNames = async (runId: string): Promise<string[]> => {
      const res = await handleMcpMessage(claimsFor(runId), { jsonrpc: "2.0", id: 1, method: "tools/list" });
      return (res!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    };

    const { runId: slackRunId } = await slackRunWithSandbox("slack run");
    expect(await listNames(slackRunId)).toEqual(expect.arrayContaining(["artifact_publish", "slack_upload"]));

    const plainId = crypto.randomUUID();
    await createRun({ id: plainId, prompt: "api run", model: "claude-opus-5", engine: "mock", orgId: ORG, userId: null, parentRunId: null, threadId: plainId });
    expect(await listNames(plainId)).not.toContain("slack_upload");
    expect(await listNames(plainId)).toContain("artifact_publish");
  });
});
