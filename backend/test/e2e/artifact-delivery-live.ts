/**
 * Real sandbox -> durable artifact -> browser + Slack acceptance journey.
 *
 * Manual because it creates one Daytona sandbox:
 *   LIVE_ARTIFACT_E2E=1 bun test/e2e/artifact-delivery-live.ts
 *
 * Safety: the journey owns a uniquely named throwaway database, a temporary
 * artifact directory, and exactly one labeled sandbox. Cleanup deletes and
 * API-verifies only those resources, even after a failed assertion.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daytona, type Sandbox } from "@daytona/sdk";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { SlackClient } from "../../src/slack/client";
import type { ToolTokenClaims } from "../../src/knowledge/gateway/token";

if (process.env.LIVE_ARTIFACT_E2E !== "1") {
  throw new Error("Set LIVE_ARTIFACT_E2E=1 to run the real Daytona artifact journey");
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
const databaseName = `skynet_artifact_live_${suffix}`;
const port = 35_000 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
const adminUrl = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const storageRoot = await mkdtemp(join(tmpdir(), "skynet-artifact-live-"));
const runId = randomUUID();
const expected = Buffer.from(`Skynet real Daytona artifact proof\nrun=${runId}\n`, "utf8");
const expectedSha = createHash("sha256").update(expected).digest("hex");

const admin = postgres(adminUrl, { max: 1 });
const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
  target: process.env.DAYTONA_TARGET ?? "us",
});
let backend: ReturnType<typeof Bun.spawn> | null = null;
let sandbox: Sandbox | null = null;
let databaseClient: (Awaited<typeof import("../../src/db/client")>)["client"] | null = null;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

async function waitForBackend(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/health`).catch(() => null);
    if (response?.ok) return;
    await Bun.sleep(200);
  }
  throw new Error("isolated backend did not become healthy");
}

async function stopBackend(): Promise<void> {
  if (!backend) return;
  backend.kill("SIGTERM");
  const exited = await Promise.race([
    backend.exited.then(() => true),
    Bun.sleep(3_000).then(() => false),
  ]);
  if (!exited) {
    backend.kill("SIGKILL");
    await backend.exited;
  }
}

try {
  await admin.unsafe(`CREATE DATABASE ${databaseName}`);

  const childEnv: Record<string, string> = {
    ...process.env,
    ALLOW_DEV_ORG: "1",
    ARTIFACT_STORAGE_DIR: storageRoot,
    BETTER_AUTH_SECRET: randomUUID() + randomUUID(),
    CONNECTOR_EMAIL_NOTIFY: "",
    DATABASE_URL: databaseUrl.toString(),
    MEMORY_API_URL: "",
    PORT: String(port),
    REQUIRE_SINGLE_BACKEND: "0",
    SLACK_BOT_TOKEN: "",
    SLACK_SIGNING_SECRET: "",
  };
  backend = Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(import.meta.dir, "../.."),
    env: childEnv,
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForBackend();
  check(true, "isolated backend is healthy");

  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.ARTIFACT_STORAGE_DIR = storageRoot;
  const [{ db, client }, { createRun, setRunSandbox }, { seedDev }] = await Promise.all([
    import("../../src/db/client"),
    import("../../src/runs/repo"),
    import("../../src/seed"),
  ]);
  databaseClient = client;
  await migrate(db, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
  await seedDev();

  const provisionStartedAt = Date.now();
  sandbox = await daytona.create({
    labels: { "skynet-run": runId, "skynet-purpose": "artifact-live-e2e" },
    autoStopInterval: 30,
    autoDeleteInterval: 60,
  });
  check(Date.now() - provisionStartedAt < 30_000, "Daytona sandbox provisioned within 30 seconds");

  const sourcePath = "/home/daytona/work/outputs/daytona-proof.txt";
  const encoded = expected.toString("base64");
  const write = await sandbox.process.executeCommand(
    `mkdir -p /home/daytona/work/outputs && printf %s ${encoded} | base64 -d > ${sourcePath}`,
    undefined,
    undefined,
    20,
  );
  check((write.exitCode ?? 1) === 0, "source bytes were written inside Daytona");

  await createRun({
    id: runId,
    prompt: "artifact delivery live proof",
    model: "test",
    engine: "mock",
    orgId: "org-skynet-dev",
    userId: null,
    parentRunId: null,
    threadId: runId,
  });
  await setRunSandbox(runId, sandbox.id);

  const { executeArtifactTool } = await import("../../src/knowledge/gateway/artifact-tools");
  const claims: ToolTokenClaims = {
    orgId: "org-skynet-dev",
    userId: "user-skynet-dev",
    threadId: runId,
    runId,
    exp: Date.now() + 60_000,
  };
  const published = await executeArtifactTool(claims, "artifact_publish", {
    path: sourcePath,
  });
  check(!published.isError, "real sandbox file published once through the agent capability");
  const publishedArtifact = published.structuredContent?.artifact as
    | { id?: string; size_bytes?: number; sha256?: string }
    | undefined;
  const artifactId = publishedArtifact?.id;
  check(typeof artifactId === "string", "publish returned a durable artifact id");
  check(publishedArtifact?.size_bytes === expected.byteLength, "published size matches source");
  check(publishedArtifact?.sha256 === expectedSha, "published digest matches source");

  const duplicated = await executeArtifactTool(claims, "artifact_publish", {
    path: sourcePath,
  });
  const duplicatedArtifact = duplicated.structuredContent?.artifact as
    | { id?: string }
    | undefined;
  check(
    duplicated.structuredContent?.created === false && duplicatedArtifact?.id === artifactId,
    "duplicate publish reuses the immutable artifact",
  );

  const browser = await fetch(`${baseUrl}/api/artifacts/${artifactId}/content`);
  const browserBytes = Buffer.from(await browser.arrayBuffer());
  check(browser.status === 200 && browserBytes.equals(expected), "browser reads exact Daytona bytes");
  check(browser.headers.get("etag") === `"sha256-${expectedSha}"`, "browser ETag carries the digest");

  const range = await fetch(`${baseUrl}/api/artifacts/${artifactId}/content`, {
    headers: { range: "bytes=7-18" },
  });
  check(
    range.status === 206 && Buffer.from(await range.arrayBuffer()).equals(expected.subarray(7, 19)),
    "browser range request returns exact bounded bytes",
  );

  const [{ linkSlackThread }, { executeSlackTool }, { processDue, stopSlackOutboxRelay }] =
    await Promise.all([
      import("../../src/slack/repo"),
      import("../../src/knowledge/gateway/slack-tools"),
      import("../../src/slack/outbox"),
    ]);
  stopSlackOutboxRelay();
  await linkSlackThread({
    teamId: "T-SKYNET-DEV",
    channel: "CARTIFACTLIVE",
    threadTs: "1720000000.000001",
    rootRunId: runId,
    orgId: "org-skynet-dev",
  });
  const firstSlack = await executeSlackTool(claims, "slack_upload", {
    artifactId,
    title: "Daytona proof",
  });
  const duplicateSlack = await executeSlackTool(claims, "slack_upload", {
    artifactId,
    title: "Daytona proof",
  });
  check(!firstSlack.isError && !duplicateSlack.isError, "Slack tool accepted the durable artifact idempotently");

  const uploads: Array<{ filename: string; bytes: Uint8Array }> = [];
  const recordingSlack: SlackClient = {
    postMessage: async () => ({ ok: true }),
    updateMessage: async () => ({ ok: true }),
    addReaction: async () => ({ ok: true }),
    setSessionStatus: async () => ({ ok: true }),
    startStream: async () => ({ ok: true, ts: "stream.1" }),
    appendStream: async () => ({ ok: true }),
    stopStream: async () => ({ ok: true }),
    uploadFile: async ({ filename, bytes }) => {
      uploads.push({ filename, bytes });
      return { ok: true };
    },
  };
  const delivered = await processDue(recordingSlack);
  check(delivered.delivered === 1 && uploads.length === 1, "Slack outbox delivered exactly once");
  const upload = uploads[0];
  check(upload?.filename === "daytona-proof.txt", "Slack filename matches the browser artifact");
  check(
    upload !== undefined && Buffer.from(upload.bytes).equals(browserBytes),
    "Slack and browser consumed the same immutable bytes",
  );

  const reloaded = await fetch(`${baseUrl}/api/artifacts?thread_id=${runId}`);
  const list = (await reloaded.json()) as { artifacts?: Array<{ id?: string }> };
  check(
    reloaded.ok && list.artifacts?.some((artifact) => artifact.id === artifactId),
    "artifact remains discoverable after an independent reload",
  );
} finally {
  await databaseClient?.end().catch(() => {});
  await stopBackend();
  if (sandbox) {
    const sandboxId = sandbox.id;
    await daytona.delete(sandbox, 60, true).catch(() => {});
    const remaining = await daytona.get(sandboxId).catch(() => null);
    check(!remaining || (remaining as { state?: string }).state === "destroyed", "owned Daytona sandbox deleted");
  }
  await admin`
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = ${databaseName} AND pid <> pg_backend_pid()
  `.catch(() => {});
  await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName}`).catch(() => {});
  await admin.end();
  await rm(storageRoot, { recursive: true, force: true });
}

console.log("ARTIFACT_LIVE_E2E PASS");
