/**
 * Offline v0.0.2 native-child release canary.
 *
 * This is intentionally manual-gated: it creates a unique local Postgres database,
 * applies the production migrations + READ index, and imports the full backend app.
 * It never starts an engine, sandbox, or paid provider request.
 *
 * Run from backend/:
 *   bun run test/manual/native-children-release-canary.ts
 *
 * The live assertion uses subscribeNative(), the exact process-local subscription
 * that feeds `GET /api/runs/:id/events`. HTTP SSE framing itself is already covered
 * elsewhere; this canary keeps the release proof deterministic and provider-free.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import * as schema from "../../src/db/schema";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DATABASE_NAME = `useagent_v002_canary_${crypto.randomUUID().slice(0, 8).replaceAll("-", "")}`;
const databaseUrl = new URL(ADMIN_URL);
databaseUrl.pathname = `/${DATABASE_NAME}`;
const DATABASE_URL = databaseUrl.toString();
const RELOAD_MARKER = "V002_RELOAD_RESULT=";
const RELOAD_TIMEOUT_MS = 15_000;

const EXTERNAL_ENV_PREFIXES = [
  "ANTHROPIC_",
  "AGENTMAIL_",
  "CUBE_",
  "DAYTONA_",
  "EMAIL_",
  "FOLLOWUPS_",
  "FREE_MODEL_",
  "GITHUB_",
  "GMAIL_",
  "GOOGLE_",
  "HUBSPOT_",
  "LINEAR_",
  "MEMORY_",
  "NOTION_",
  "OOMOL_",
  "OPENAI_",
  "OPENCONNECTOR_",
  "OPENROUTER_",
  "PROVIDER_GATEWAY_",
  "REDIS_",
  "RUNTIME_",
  "RESEND_",
  "SLACK_",
  "SMTP_",
  "T3_",
  "TENCENT_",
  "TOOL_GATEWAY_",
] as const;

interface GraphExecution {
  readonly id: string;
  readonly mode: "root" | "native_child";
  readonly native_session_id: string | null;
  readonly native_parent_session_id: string | null;
  readonly status: string;
}

interface GraphEdge {
  readonly id: string;
  readonly kind: string;
  readonly child_execution_id: string | null;
  readonly native_target_session_id: string | null;
}

interface GraphResponse {
  readonly executions: GraphExecution[];
  readonly delegation_edges: GraphEdge[];
}

interface TranscriptResponse {
  readonly events: Array<{
    readonly eventId: string;
    readonly kind: string;
    readonly identity: { readonly nativeSessionId?: string };
  }>;
}

interface ReloadResult {
  readonly graph: GraphResponse;
  readonly transcripts: Record<string, TranscriptResponse>;
}

function localAdminRequired(): void {
  const host = new URL(ADMIN_URL).hostname;
  assert.ok(
    host === "localhost" || host === "127.0.0.1" || host === "::1",
    `refusing to create/drop canary database through non-local admin host ${host}`,
  );
  assert.match(DATABASE_NAME, /^useagent_v002_canary_[0-9a-f]{8}$/);
}

function configureOfflineEnvironment(url: string): void {
  for (const key of Object.keys(process.env)) {
    if (EXTERNAL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete process.env[key];
    }
  }
  for (const key of [
    "CODE_INDEX_INTERVAL_MIN",
    "GATEWAY_DATABASE_URL",
    "GATEWAY_PUBLIC_URL",
    "GH_TOKEN",
    "INTEGRATIONS_BUNDLE_B64",
    "MEMORY_API_URL",
    "REDIS_URL",
    "SANDBOX_PROVIDER",
    "SKILLS_RESYNC_INTERVAL_MIN",
  ]) {
    delete process.env[key];
  }
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = url;
  // The in-process API helper does not need a network listener. Port 0 prevents
  // this manual canary from colliding with a developer's running app.
  process.env.PORT = "0";
  process.env.EXECUTION_GRAPH_ROLLOUT = "read";
  process.env.REQUIRE_SINGLE_BACKEND = "false";
  process.env.BETTER_AUTH_SECRET = "v002-offline-canary-secret-not-for-production";
  process.env.FRONTEND_ORIGIN = "http://localhost:3200";
  process.env.FREE_MODEL_QUALIFIER_ENABLED = "false";
  process.env.FLEET_RECONCILER_AUTOSTART = "0";
  process.env.DAYTONA_WARM_POOL_SIZE = "0";
  process.env.CUBE_WARM_POOL_SIZE = "0";
  process.env.CUBE_T3_WARM_POOL_SIZE = "0";
}

async function apiRead<T>(path: string, cookies: string): Promise<T> {
  const { json } = await import("../helpers");
  const response = await json<T>(path, { cookies });
  assert.equal(response.status, 200, `${path} returned HTTP ${response.status}`);
  return response.body;
}

async function readGraphAndTranscripts(
  runId: string,
  cookies: string,
): Promise<ReloadResult> {
  const graph = await apiRead<GraphResponse>(`/api/runs/${runId}/executions`, cookies);
  const transcripts: Record<string, TranscriptResponse> = {};
  for (const execution of graph.executions.filter((row) => row.mode === "native_child")) {
    transcripts[execution.native_session_id!] = await apiRead<TranscriptResponse>(
      `/api/runs/${runId}/executions/${execution.id}/events?limit=200`,
      cookies,
    );
  }
  return { graph, transcripts };
}

async function reloadProbe(): Promise<void> {
  const runId = process.env.V002_CANARY_RUN_ID;
  const cookies = process.env.V002_CANARY_COOKIES;
  assert.ok(runId && cookies && process.env.DATABASE_URL, "reload probe requires canary context");
  const result = await readGraphAndTranscripts(runId, cookies);
  console.log(`${RELOAD_MARKER}${JSON.stringify(result)}`);
  const { client } = await import("../../src/db/client");
  await client.end();
}

type RuntimeActivity = Parameters<
  typeof import("../../src/engines/runtime-orchestration").runtimeActivityProviderEvent
>[2];

function childActivity(
  id: string,
  kind: "task.started" | "task.completed" | "task.failed",
  childId: string,
  parentId: string,
): RuntimeActivity {
  return {
    id,
    tone: kind === "task.failed" ? "error" : "info",
    kind,
    summary: `${childId} ${kind}`,
    payload: {
      taskId: childId,
      parentAgentId: parentId,
      toolUseId: `spawn-${childId}`,
      agentKind: "agent",
      status: kind === "task.started" ? "running" : kind === "task.failed" ? "failed" : "completed",
      result: kind === "task.failed" ? undefined : `${childId} result`,
    },
    turnId: "turn-release-canary",
  };
}

async function runCanary(): Promise<void> {
  localAdminRequired();
  const admin = postgres(ADMIN_URL, { max: 1 });
  let appClient: Sql | null = null;
  let databaseCreated = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${DATABASE_NAME}"`);
    databaseCreated = true;
    const bootstrapClient = postgres(DATABASE_URL, { max: 1 });
    const bootstrapDb = drizzle(bootstrapClient, { schema });
    await migrate(bootstrapDb, { migrationsFolder: join(import.meta.dir, "..", "..", "drizzle") });
    await bootstrapClient.end();

    configureOfflineEnvironment(DATABASE_URL);
    const { applyCanonicalExecutionTranscriptIndex } = await import(
      "../../src/db/online-indexes/canonical-execution-transcript"
    );
    assert.deepEqual(
      await applyCanonicalExecutionTranscriptIndex({ databaseUrl: DATABASE_URL }),
      { kind: "exact-valid" },
    );

    const [
      { createOrgSession },
      { createRun },
      { db, client },
      { agentExecutions },
      { recordProviderEvent },
      { subscribeNative },
      { runtimeActivityProviderEvent },
      { createSecretRedactor },
      { finalizeRun },
      { runCanonicalizationOutboxOnce },
    ] = await Promise.all([
      import("../helpers"),
      import("../../src/runs/repo"),
      import("../../src/db/client"),
      import("../../src/db/schema"),
      import("../../src/runs/provider-events"),
      import("../../src/runs/native-events"),
      import("../../src/engines/runtime-orchestration"),
      import("../../src/secrets/redact"),
      import("../../src/runs/finalize"),
      import("../../src/runs/canonicalization-outbox"),
    ] as const);
    appClient = client;

    const owner = await createOrgSession("v002-release-canary");
    const runId = crypto.randomUUID();
    const parentId = "codex-parent-release-canary";
    const children = ["codex-child-alpha", "codex-child-beta", "codex-child-gamma"] as const;
    await createRun({
      id: runId,
      prompt: "offline v0.0.2 native-child release canary",
      model: "offline-fixture",
      engine: "codex",
      orgId: owner.orgId,
      userId: null,
      parentRunId: null,
      threadId: runId,
      repos: [],
      memoryScope: "org",
      origin: "internal:v002-native-child-release-canary",
    });

    const redact = createSecretRedactor([]);
    const normalized = (activity: RuntimeActivity) =>
      runtimeActivityProviderEvent({ runId, threadId: runId }, parentId, activity, redact);
    const wait = normalized({
      id: "wait-before-beta-spawn",
      tone: "tool",
      kind: "tool.completed",
      summary: "Wait for native children",
      payload: {
        itemType: "collab_agent_tool_call",
        delegationKind: "wait",
        toolUseId: "wait-all",
        receiverThreadIds: [...children, "codex-ghost-wait-target"],
      },
      turnId: "turn-release-canary",
    });
    const spawnAlpha = normalized(childActivity("spawn-alpha", "task.started", children[0], parentId));

    // Captured-order fixture from the T3/Codex normalization boundary. It is
    // deliberately non-causal: beta completes before its spawn, wait arrives
    // before beta's spawn, and alpha's stable spawn id is revised/replayed.
    const fixture = [
      {
        id: `${runId}:root-started`, runId, threadId: runId, provider: "t3",
        eventType: "session.started", nativeSessionId: parentId,
        payload: { capabilities: {}, source: "offline-codex-normalized-fixture" },
      },
      normalized(childActivity("beta-complete-early", "task.completed", children[1], parentId)),
      normalized(childActivity("spawn-gamma", "task.started", children[2], parentId)),
      spawnAlpha,
      wait,
      normalized(childActivity("spawn-beta", "task.started", children[1], parentId)),
      { ...spawnAlpha, payload: { ...(spawnAlpha.payload as object), fixtureRevision: 2 } },
      normalized(childActivity("alpha-complete", "task.completed", children[0], parentId)),
      normalized(childActivity("gamma-failed", "task.failed", children[2], parentId)),
      normalized(childActivity("beta-complete-final", "task.completed", children[1], parentId)),
      {
        id: `${runId}:parent-completed`, runId, threadId: runId, provider: "t3",
        eventType: "session.completed", nativeSessionId: parentId,
        payload: { status: "completed" },
      },
    ] as const;

    const liveFrames: Array<{ eventId: string; seq: number }> = [];
    const unsubscribe = subscribeNative(runId, (frame) => {
      liveFrames.push({ eventId: frame.eventId, seq: frame.seq });
    });
    const childRowLatenciesMs: number[] = [];
    try {
      for (const event of fixture) {
        const started = performance.now();
        await recordProviderEvent(event, { critical: true, required: true });
        if (event.eventType === "t3.activity.task.started") {
          const nativeSessionId = event.nativeSessionId!;
          const [row] = await db.select({ id: agentExecutions.id })
            .from(agentExecutions)
            .where(
              and(
                eq(agentExecutions.runId, runId),
                eq(agentExecutions.nativeSessionId, nativeSessionId),
              ),
            )
            .limit(1);
          assert.ok(row, `spawn ${nativeSessionId} did not create a child row`);
          childRowLatenciesMs.push(performance.now() - started);
        }
      }
    } finally {
      unsubscribe();
    }

    assert.equal(liveFrames.length, fixture.length, "the exact SSE source observed every awaited write");
    assert.deepEqual(liveFrames.map((frame) => frame.seq), fixture.map((_, index) => index));
    assert.equal(
      liveFrames.filter((frame) => frame.eventId === spawnAlpha.id).length,
      2,
      "a stable-id revision remains visible live with a later seq",
    );

    await finalizeRun(runId, "completed", "offline release canary complete", 1);
    assert.equal(await runCanonicalizationOutboxOnce(1), 1, "canonicalization completed after seal");

    const pageStarted = performance.now();
    const firstRead = await readGraphAndTranscripts(runId, owner.cookies);
    const pageReadMs = performance.now() - pageStarted;
    assertReleaseShape(firstRead, children, parentId);

    const reloadStarted = performance.now();
    const child = Bun.spawn([
      process.execPath,
      "run",
      import.meta.path,
      "--reload",
    ], {
      cwd: join(import.meta.dir, "..", ".."),
      env: {
        ...process.env,
        DATABASE_URL,
        EXECUTION_GRAPH_ROLLOUT: "read",
        REQUIRE_SINGLE_BACKEND: "false",
        V002_CANARY_RUN_ID: runId,
        V002_CANARY_COOKIES: owner.cookies,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    const completion = Promise.all([child.exited, stdoutPromise, stderrPromise]);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`fresh reload exceeded ${RELOAD_TIMEOUT_MS}ms`));
      }, RELOAD_TIMEOUT_MS);
    });
    let exitCode: number;
    let stdout: string;
    let stderr: string;
    try {
      [exitCode, stdout, stderr] = await Promise.race([completion, deadline]);
    } catch (error) {
      child.kill("SIGKILL");
      await Promise.allSettled([child.exited, stdoutPromise, stderrPromise]);
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    assert.equal(exitCode, 0, `fresh reload failed:\n${stderr}\n${stdout}`);
    const reloadLine = stdout.split("\n").find((line) => line.startsWith(RELOAD_MARKER));
    assert.ok(reloadLine, `fresh reload returned no result:\n${stdout}`);
    const reloaded = JSON.parse(reloadLine.slice(RELOAD_MARKER.length)) as ReloadResult;
    assertReleaseShape(reloaded, children, parentId);
    assert.deepEqual(reloaded, firstRead, "fresh-process graph and transcripts match the first read");
    const reloadMs = performance.now() - reloadStarted;

    console.log("\n[v0.0.2 native-child release canary] PASS");
    console.log(`  provider events observed live: ${liveFrames.length}`);
    console.log(`  child executions: ${children.length}; wait edges: ${firstRead.graph.delegation_edges.filter((edge) => edge.kind === "wait").length}`);
    console.log(`  event-to-child-row max: ${Math.max(...childRowLatenciesMs).toFixed(2)} ms`);
    console.log(`  authenticated graph + transcript page read: ${pageReadMs.toFixed(2)} ms`);
    console.log(`  fresh-process reload/read: ${reloadMs.toFixed(2)} ms`);
    console.log("  scope: local Postgres + in-process backend subscription/API only; no provider, network, or sandbox speed claim");
  } finally {
    if (appClient) await appClient.end().catch(() => {});
    if (databaseCreated) {
      await admin`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = ${DATABASE_NAME} AND pid <> pg_backend_pid()
      `.catch(() => {});
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DATABASE_NAME}"`).catch(() => {});
    }
    await admin.end();
  }
}

function assertReleaseShape(
  result: ReloadResult,
  childIds: readonly string[],
  parentId: string,
): void {
  const children = result.graph.executions.filter((row) => row.mode === "native_child");
  const roots = result.graph.executions.filter((row) => row.mode === "root");
  assert.equal(roots.length, 1);
  assert.equal(roots[0]!.native_session_id, parentId);
  assert.equal(children.length, 3, "only the three explicit spawn identities become children");
  assert.deepEqual(children.map((row) => row.native_session_id).sort(), [...childIds].sort());
  assert.ok(
    children.every((row) => row.native_parent_session_id === parentId),
    "every native child retains the authoritative parent session",
  );
  const statusByChild = new Map(children.map((row) => [row.native_session_id, row.status]));
  assert.equal(statusByChild.get("codex-child-alpha"), "completed");
  assert.equal(statusByChild.get("codex-child-beta"), "completed");
  assert.equal(statusByChild.get("codex-child-gamma"), "failed");
  assert.ok(result.graph.executions.every((row) =>
    row.status === "completed" || row.status === "failed" || row.status === "cancelled"
  ), "seal leaves every execution terminal");
  assert.equal(new Set(result.graph.executions.map((row) => row.id)).size, result.graph.executions.length);
  assert.equal(new Set(result.graph.delegation_edges.map((row) => row.id)).size, result.graph.delegation_edges.length);

  const spawnEdges = result.graph.delegation_edges.filter((edge) => edge.kind === "spawn");
  const waitEdges = result.graph.delegation_edges.filter((edge) => edge.kind === "wait");
  assert.equal(spawnEdges.length, 3, "spawn replay is idempotent");
  assert.equal(waitEdges.length, 4, "one wait observation produces only target edges");
  assert.ok(spawnEdges.every((edge) => edge.child_execution_id !== null));
  assert.ok(waitEdges.some((edge) =>
    edge.native_target_session_id === "codex-ghost-wait-target" && edge.child_execution_id === null
  ), "a wait target without a spawn remains edge-only and does not fabricate a child");

  for (const childId of childIds) {
    const transcript = result.transcripts[childId];
    assert.ok(transcript, `missing transcript for ${childId}`);
    assert.ok(transcript.events.length > 0, `empty transcript for ${childId}`);
    assert.ok(transcript.events.every((event) => event.identity.nativeSessionId === childId));
  }
}

if (process.argv.includes("--reload")) await reloadProbe();
else await runCanary();
