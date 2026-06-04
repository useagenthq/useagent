/**
 * LIVE timings proof (perf program final measurement). Runs ONE real OpenCode
 * thread over TWO turns (cold create, then warm follow-up) on REAL Daytona using
 * the NEW warm-pool-eligible snapshot, then reads the Phase 0 timing ledger
 * (GET /api/runs/:id/timings) for both runs and prints the stage table. The point
 * is to SEE the runtime span (config activation) collapse on the warm turn - the
 * ~5.2s activate -> a fast verify (task #195).
 *
 *   bun run test/e2e/live-timings.ts
 *
 * Isolation (NEVER the shared stack): throwaway DB useagent_e2e_timings, backend
 * on :3515, gateway on :3516, and a tunnel to the gateway for sandbox access.
 * Requires backend/.env to carry DAYTONA_API_KEY + a provider key
 * (OPENROUTER_API_KEY / ANTHROPIC_API_KEY); the gateway resolves the org
 * credential from those (credentials.ts env fallback). Teardown deletes the
 * thread sandbox (API-verified), drops the DB, and stops both services + tunnel.
 *
 * OpenCode HARD-REQUIRES a wired provider gateway (public URL) - there is no
 * host-key fallback for it - so a tunnel is mandatory to run a live turn. The
 * config path measured here is: GATEWAY ACTIVE (tunnel), env-fallback credential.
 */
import { openSync, readFileSync } from "node:fs";
import { Daytona } from "@daytona/sdk";
import postgres from "postgres";
import { DEFAULT_OPENCODE_MODEL } from "../../src/runs/model-policy";
import { startPublicTunnel, tunnelProviderOrder, type PublicTunnel } from "./lib/public-tunnel";
import { stopOwnedProcess } from "./lib/process-lifecycle";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB = "useagent_e2e_timings";
const DB_URL = `postgres://postgres@localhost:5432/${DB}`;
const PORT = 3515;
const GATEWAY_PORT = 3516;
const BASE = `http://localhost:${PORT}`;
const GATEWAY_BASE = `http://localhost:${GATEWAY_PORT}`;
const SNAPSHOT = process.env.LIVE_TIMINGS_SNAPSHOT ?? "skynet-opencode-ffa3be54bc";
const MODEL = process.env.LIVE_TIMINGS_MODEL ?? DEFAULT_OPENCODE_MODEL;
const COLD_PROMPT =
  process.env.LIVE_TIMINGS_COLD_PROMPT ??
  "T1 Reply with a one-word greeting and nothing else.";
const WARM_PROMPT =
  process.env.LIVE_TIMINGS_WARM_PROMPT ??
  "T2 Reply with a one-word farewell and nothing else.";
const TOOL_GATEWAY_ENABLED = process.env.LIVE_TIMINGS_TOOL_GATEWAY !== "off";
const TURN_BUDGET_MS = 8 * 60 * 1000;
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const backendLog = `${scratch}/skynet-e2e-timings-backend.log`;
const tunnelLog = `${scratch}/skynet-e2e-timings-tunnel.log`;
const backendDir = new URL("../..", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const providerSecret = `provider-timings-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const toolSecret = `tool-timings-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const encryptionSecret = `encryption-timings-${crypto.randomUUID()}-${crypto.randomUUID()}`;

type Proc = ReturnType<typeof Bun.spawn>;
const sql = postgres(DB_URL, { max: 4 });

function sh(cmd: string): string {
  try { return Bun.spawnSync(["bash", "-lc", cmd]).stdout.toString().trim(); } catch { return ""; }
}
function tailLog(path: string, lines = 30): void {
  try {
    const all = readFileSync(path, "utf8").trimEnd().split("\n");
    console.log(`  -- log tail (${path}) --`);
    for (const l of all.slice(-lines)) console.log(`  | ${l}`);
  } catch { /* no log */ }
}

async function recreateDb(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
}
async function dropDb(): Promise<void> {
  await sql.end().catch(() => {});
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await admin.end();
}

async function startBackend(publicUrl: string): Promise<Proc> {
  const fd = openSync(backendLog, "a");
  const childEnv: Record<string, string | undefined> = {
    ...process.env, // real DAYTONA_API_KEY + OPENROUTER/ANTHROPIC provider keys
    PORT: String(PORT),
    DATABASE_URL: DB_URL,
    FRONTEND_ORIGIN: "http://localhost:3400",
    // The measurement target: the NEW warm-pool-eligible snapshot.
    DAYTONA_SNAPSHOT: SNAPSHOT,
    PROVIDER_GATEWAY_SECRET: providerSecret,
    // Warm pool OFF for this measurement (we want a cold create then a warm
    // thread-reuse, not a pool claim): leave DAYTONA_WARM_POOL_SIZE unset.
  };
  delete childEnv.GATEWAY_PUBLIC_URL;
  delete childEnv.PROVIDER_GATEWAY_PUBLIC_URL;
  delete childEnv.TOOL_GATEWAY_SECRET;
  if (TOOL_GATEWAY_ENABLED) {
    childEnv.GATEWAY_PUBLIC_URL = publicUrl;
    childEnv.TOOL_GATEWAY_SECRET = toolSecret;
  } else {
    // Keep the model gateway reachable while intentionally leaving the optional
    // tool gateway unwired for a provider-only parity run.
    childEnv.PROVIDER_GATEWAY_PUBLIC_URL = publicUrl;
  }
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: backendDir,
    // Provider-parity checks may intentionally omit the optional knowledge /
    // memory gateway. This keeps a transient public-tunnel SSE failure from
    // masking the sandbox, terminal, browser, and model path under test.
    env: childEnv,
    stdout: fd,
    stderr: fd,
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        console.log(`  backend up on :${PORT} (pid ${proc.pid})`);
        return proc;
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`backend did not come up (see ${backendLog})`);
}
async function stopServiceProcess(proc: Proc): Promise<void> {
  proc.kill(9);
  await proc.exited;
}

async function startGateway(publicUrl: string): Promise<Proc> {
  const fd = openSync(backendLog, "a");
  const proc = Bun.spawn(["bun", "src/gateway.ts"], {
    cwd: backendDir,
    env: {
      ...process.env,
      GATEWAY_PORT: String(GATEWAY_PORT),
      DATABASE_URL: DB_URL,
      GATEWAY_DATABASE_URL: DB_URL,
      PROVIDER_GATEWAY_PUBLIC_URL: publicUrl,
      PROVIDER_GATEWAY_SECRET: providerSecret,
      TOOL_GATEWAY_SECRET: toolSecret,
      SECRETS_ENCRYPTION_KEY: encryptionSecret,
    },
    stdout: fd,
    stderr: fd,
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${GATEWAY_BASE}/api/health`);
      if (response.ok) {
        console.log(`  gateway up on :${GATEWAY_PORT} (pid ${proc.pid})`);
        return proc;
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`gateway did not come up (see ${backendLog})`);
}

/** Establish a PUBLIC tunnel BEFORE the backend boots (the backend needs the URL
 *  as GATEWAY_PUBLIC_URL at spawn). A minted URL means the tunnel process reached
 *  its edge; the tunnel -> backend path is validated by the LIVE sandbox turn, NOT
 *  by a local curl (the Daytona sandbox, not this machine, resolves + reaches the
 *  tunnel, and a fresh quick-tunnel subdomain often lags the local resolver). */
async function establishTunnel(): Promise<PublicTunnel> {
  const providers = tunnelProviderOrder(process.env.E2E_TUNNEL_PROVIDER);
  let lastErr = "no provider tried";
  for (const provider of providers) {
    try {
      const t = await startPublicTunnel({ localPort: GATEWAY_PORT, logPath: tunnelLog, provider });
      console.log(`  tunnel[${provider}]: ${t.publicUrl} (edge routing validated by the live turn)`);
      return t;
    } catch (e) {
      lastErr = (e as Error).message;
      console.log(`  tunnel[${provider}] failed to start: ${lastErr}`);
      await sleep(1000);
    }
  }
  throw new Error(`no tunnel provider started (last: ${lastErr})`);
}

async function createRun(body: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${BASE}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as { id?: string; error?: string };
  if (!j.id) throw new Error(`createRun failed: HTTP ${r.status} ${j.error ?? ""}`);
  return j.id;
}
async function waitRun(runId: string, budgetMs: number): Promise<any> {
  const deadline = Date.now() + budgetMs;
  let last: any = null;
  while (Date.now() < deadline) {
    [last] = await sql`select * from runs where id = ${runId}`;
    if (last && (last.status === "completed" || last.status === "failed")) return last;
    await sleep(2500);
  }
  return last;
}

interface TimingRow { stage: string; kind: string; startedAt: number; endedAt: number | null; durMs: number | null }
interface TimingTable { rows: TimingRow[]; dispatchAt: number | null; timeToFirstEventMs: number | null; totalMs: number | null }

async function timings(runId: string): Promise<TimingTable> {
  const r = await fetch(`${BASE}/api/runs/${runId}/timings`);
  if (!r.ok) throw new Error(`timings HTTP ${r.status}`);
  return (await r.json()) as TimingTable;
}
function spanMs(t: TimingTable, stage: string): number | null {
  const row = t.rows.find((x) => x.stage === stage && x.kind === "span");
  return row?.durMs ?? null;
}
function printTable(label: string, t: TimingTable): void {
  console.log(`\n  ── timings: ${label} ──`);
  for (const row of t.rows) {
    const dur = row.kind === "span" ? `${row.durMs}ms` : "(mark)";
    console.log(`    ${row.stage.padEnd(10)} ${row.kind.padEnd(5)} ${dur}`);
  }
  console.log(`    dispatchAt=${t.dispatchAt} timeToFirstEventMs=${t.timeToFirstEventMs} totalMs=${t.totalMs}`);
}

async function reasoningFrames(runId: string): Promise<number> {
  const [row] = await sql`select count(*)::int as n from provider_events where run_id = ${runId} and event_type like 'part.reasoning%'`;
  return row?.n ?? 0;
}

async function cleanupSandboxes(): Promise<void> {
  if (!process.env.DAYTONA_API_KEY) return;
  console.log("\n── cleanup: deleting the thread sandbox ──");
  const runIds = new Set((await sql`select id from runs`.catch(() => [])).map((r) => r.id as string));
  const ids = new Set(
    (await sql`select distinct sandbox_id from runs where sandbox_id is not null`.catch(() => [])).map((r) => r.sandbox_id as string),
  );
  const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY!, target: process.env.DAYTONA_TARGET ?? "us" });
  try {
    for await (const sb of d.list()) {
      const label = (sb as { labels?: Record<string, string> }).labels?.["skynet-run"];
      if (label && runIds.has(label)) ids.add(sb.id);
    }
  } catch { /* list best-effort */ }
  for (const id of ids) {
    try {
      await (await d.get(id)).delete();
      // API-verify deletion (Daytona hygiene).
      let gone = false;
      for (let i = 0; i < 10 && !gone; i++) {
        gone = await d.get(id).then(() => false).catch(() => true);
        if (!gone) await sleep(2000);
      }
      console.log(`  🗑  sandbox ${id.slice(0, 12)} ${gone ? "deleted (API-verified)" : "delete UNVERIFIED"}`);
    } catch (e) {
      console.log(`  ⚠️  could not delete sandbox ${id.slice(0, 12)}: ${(e as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const sha = sh("git rev-parse --short HEAD") || "unknown";
  console.log(`LIVE TIMINGS PROOF — snapshot=${SNAPSHOT} model=${MODEL} DB=${DB} PORT=${PORT}`);
  console.log(`  commit ${sha} · bun ${Bun.version} · DAYTONA_API_KEY=${process.env.DAYTONA_API_KEY ? "on" : "off"} · OPENROUTER=${process.env.OPENROUTER_API_KEY ? "on" : "off"} · ANTHROPIC=${process.env.ANTHROPIC_API_KEY ? "on" : "off"}`);
  if (!process.env.DAYTONA_API_KEY) { console.error("ABORT: DAYTONA_API_KEY unset"); process.exit(2); }

  await recreateDb();

  console.log("  establishing a public tunnel to the isolated gateway…");
  let tunnel: PublicTunnel;
  try {
    tunnel = await establishTunnel();
  } catch (e) {
    console.error(`  FATAL: ${(e as Error).message}`);
    await dropDb().catch(() => {});
    process.exit(1);
  }
  console.log(`  tunnel: ${tunnel.publicUrl} (${tunnel.provider})`);

  let backendProc: Proc | null = null;
  let gatewayProc: Proc | null = null;
  let ok = false;
  try {
    gatewayProc = await startGateway(tunnel.publicUrl);
    backendProc = await startBackend(tunnel.publicUrl);

    // Safety: confirm the backend is on the throwaway DB before ANY real work.
    const probeId = await createRun({ prompt: "db-probe", engine: "mock", model: MODEL });
    const onThrowaway = (await sql`select 1 from runs where id = ${probeId}`).length === 1;
    if (!onThrowaway) throw new Error("backend is NOT on the throwaway DB — refusing to continue");

    // The tunnel -> dedicated gateway path is exercised by the live sandbox turn
    // below (the sandbox resolves + reaches the tunnel; a local curl here would
    // test the wrong path and flakes on fresh quick-tunnel DNS).
    console.log(`  gateway path: sandbox -> ${tunnel.publicUrl}/api/provider -> gateway (validated by the turn)`);

    // ── Turn 1: COLD create ────────────────────────────────────────────────────
    console.log("\n── Turn 1 (COLD: fresh sandbox, full config activation) ──");
    const t1 = await createRun({ prompt: COLD_PROMPT, engine: "opencode", model: MODEL });
    console.log(`  run1 ${t1} created; waiting (up to ${TURN_BUDGET_MS / 1000}s)…`);
    const r1 = await waitRun(t1, TURN_BUDGET_MS);
    console.log(`  run1 status=${r1?.status} sandbox=${r1?.sandbox_id?.slice(0, 8)} session=${r1?.engine_session_id ? "yes" : "no"} summary="${String(r1?.summary ?? "").slice(0, 60)}"`);

    // ── Turn 2: WARM follow-up (same thread, sandbox + session reused) ──────────
    console.log("\n── Turn 2 (WARM: thread reuse, config should be a fast verify) ──");
    const t2 = await createRun({ prompt: WARM_PROMPT, engine: "opencode", model: MODEL, parent_run_id: t1 });
    console.log(`  run2 ${t2} created; waiting (up to ${TURN_BUDGET_MS / 1000}s)…`);
    const r2 = await waitRun(t2, TURN_BUDGET_MS);
    console.log(`  run2 status=${r2?.status} sameSandbox=${r2?.sandbox_id === r1?.sandbox_id} sameSession=${r2?.engine_session_id === r1?.engine_session_id} summary="${String(r2?.summary ?? "").slice(0, 60)}"`);

    // ── Timing tables ──────────────────────────────────────────────────────────
    const tt1 = await timings(t1).catch((e) => { console.log(`  timings(run1) error: ${(e as Error).message}`); return null; });
    const tt2 = await timings(t2).catch((e) => { console.log(`  timings(run2) error: ${(e as Error).message}`); return null; });
    if (tt1) printTable("run1 COLD", tt1);
    if (tt2) printTable("run2 WARM", tt2);

    if (tt1 && tt2) {
      const rt1 = spanMs(tt1, "runtime");
      const rt2 = spanMs(tt2, "runtime");
      console.log("\n── RUNTIME-SPAN COLLAPSE (the #195 win) ──");
      console.log(`  runtime span: COLD=${rt1}ms  WARM=${rt2}ms  ${rt1 != null && rt2 != null ? `(delta ${rt1 - rt2}ms, ${(rt2 / rt1 * 100).toFixed(0)}% of cold)` : ""}`);
      console.log(`  sandbox span: COLD=${spanMs(tt1, "sandbox")}ms  WARM=${spanMs(tt2, "sandbox")}ms`);
      console.log(`  prepare span: COLD=${spanMs(tt1, "prepare")}ms  WARM=${spanMs(tt2, "prepare")}ms`);
      console.log(`  repos span:   COLD=${spanMs(tt1, "repos")}ms  WARM=${spanMs(tt2, "repos")}ms`);
      console.log(`  timeToFirstEvent: COLD=${tt1.timeToFirstEventMs}ms  WARM=${tt2.timeToFirstEventMs}ms`);
    }

    // ── Reasoning frames (only if the model thinks) ────────────────────────────
    const rf1 = await reasoningFrames(t1);
    const rf2 = await reasoningFrames(t2);
    console.log(`\n  reasoning (part.reasoning) frames: run1=${rf1} run2=${rf2} — ${rf1 + rf2 > 0 ? "reasoning FLOWED" : "no reasoning parts (model likely non-thinking, e.g. haiku)"}`);

    ok = (r1?.status === "completed") && (r2?.status === "completed") && !!tt1 && !!tt2;
  } catch (e) {
    console.error(`  FATAL: ${(e as Error).message}`);
    tailLog(backendLog, 40);
  } finally {
    if (backendProc) await stopServiceProcess(backendProc).catch(() => {});
    if (gatewayProc) await stopServiceProcess(gatewayProc).catch(() => {});
    await cleanupSandboxes().catch((e) => console.log(`  cleanup error: ${(e as Error).message}`));
    await stopOwnedProcess(tunnel.process).catch(() => {});
    await dropDb().catch(() => {});
  }

  console.log(`\n${ok ? "✅ LIVE TIMINGS PROOF: both turns completed + tables captured" : "⚠️  LIVE TIMINGS PROOF: incomplete (see above / backend log) — reporting what was measured"}`);
  process.exit(ok ? 0 : 1);
}

await main();
