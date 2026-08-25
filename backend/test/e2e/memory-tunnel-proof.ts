/**
 * DEFINING two-sandbox memory E2E (new_mem_prompt.md 12.3) on REAL Daytona sandboxes.
 * MANUAL-gated (spends real Daytona + LLM tokens + a public quick-tunnel):
 *
 *     bun run test/e2e/memory-tunnel-proof.ts
 *
 * Boots an ISOLATED backend (throwaway DB `useagent_memtun_e2e`, PORT 3502 - NEVER
 * the shared `useagent` DB) with the REAL Daytona/opencode/:8420 keys, and exposes it
 * via `cloudflared` so the sandbox agent can reach the Skynet memory MCP gateway
 * (GATEWAY_PUBLIC_URL = the dedicated-gateway tunnel origin). Then proves cross-sandbox memory:
 *
 *   A. Sandbox A: "remember my favourite color is teal-XXXX" -> the opencode agent
 *      calls the real memory_remember tool -> Tencent L0 accepted (memory.l0_accepted
 *      event with a tencent:l0: ref). No memory_files/memory.md dependence.
 *   B. Sandbox B (a DIFFERENT thread = a fresh sandbox), immediately: "what is my
 *      favourite color?" -> the answer is teal-XXXX, recalled from Tencent (L0),
 *      surfaced by pre-turn recall (context.retrieved) and/or a memory_search call.
 *
 * Teardown: kill the tunnel, delete + API-verify every sandbox, drop the DB, and
 * sweep the teal marker's L1 fact from the shared pool.
 */
import { closeSync, openSync, readFileSync } from "node:fs";
import { Daytona } from "@daytona/sdk";
import postgres from "postgres";
import { stopOwnedProcess, stopOwnedProcesses } from "./lib/process-lifecycle";
import {
  startPublicTunnel,
  tunnelProviderOrder,
  waitForPublicHttp,
} from "./lib/public-tunnel";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB = "useagent_memtun_e2e";
const DB_URL = `postgres://postgres@localhost:5432/${DB}`;
const PORT = 3502;
const BASE = `http://localhost:${PORT}`;
const GATEWAY_PORT = 3503;
const GATEWAY_BASE = `http://localhost:${GATEWAY_PORT}`;
// Opus by default: reliable tool-calling is essential for a deterministic proof
// (haiku intermittently narrated a save WITHOUT calling memory_remember). This
// also mirrors real user sessions (the engine default is claude-opus-5).
const MODEL = process.env.PROOF_MODEL ?? "claude-opus-5";
const backendDir = new URL("../..", import.meta.url).pathname;
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const backendLog = `${scratch}/skynet-memtun-backend.log`;
const gatewayLog = `${scratch}/skynet-memtun-gateway.log`;
const tunnelLog = `${scratch}/skynet-memtun-tunnel.log`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const providerSigningSecret = `provider-live-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const toolSigningSecret = `tool-live-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const secretsEncryptionKey = `encryption-live-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const MARKER = `teal-${crypto.randomUUID().slice(0, 8)}`;
// Unauthenticated runs resolve to the seeded dev org (org middleware fallback),
// so the memory pool is team_id=org-skynet-dev / user_id=org:org-skynet-dev.
const POOL_TEAM = "org-skynet-dev";
const POOL_USER = `org:${POOL_TEAM}`;

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const note = (m: string) => console.log(`  · ${m}`);

const sql = postgres(DB_URL, { max: 4 });
type Proc = ReturnType<typeof Bun.spawn>;

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

/** Start a test-only public tunnel to the gateway-only port. Pinggy is the
 * deterministic default for this paid proof; callers can select another shared
 * provider through E2E_TUNNEL_PROVIDER. */
async function startTunnel(): Promise<{ proc: Proc; origin: string }> {
  const [provider] = tunnelProviderOrder(
    process.env.E2E_TUNNEL_PROVIDER ?? "pinggy",
  );
  const tunnel = await startPublicTunnel({
    localPort: GATEWAY_PORT,
    logPath: tunnelLog,
    provider: provider!,
  });
  return { proc: tunnel.process as Proc, origin: tunnel.publicUrl };
}

async function startBackend(publicUrl: string, memoryUrl?: string): Promise<Proc> {
  const fd = openSync(backendLog, "a");
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.PORT = String(PORT);
  env.DATABASE_URL = DB_URL; // wins over .env's shared useagent
  env.GATEWAY_PUBLIC_URL = publicUrl; // sandbox-reachable gateway-only origin
  env.PROVIDER_GATEWAY_SECRET = providerSigningSecret;
  env.TOOL_GATEWAY_SECRET = toolSigningSecret;
  env.SECRETS_ENCRYPTION_KEY = secretsEncryptionKey;
  // Phase 3 points memory at a DEAD host to prove outage handling; else .env's :8420.
  if (memoryUrl !== undefined) env.MEMORY_API_URL = memoryUrl;
  // DAYTONA_* / ANTHROPIC_API_KEY / BETTER_AUTH_SECRET ride from .env.
  let proc: Proc;
  try {
    proc = Bun.spawn(["bun", "src/index.ts"], { cwd: backendDir, env, stdout: fd, stderr: fd });
  } finally {
    closeSync(fd);
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) {
        console.log(`  backend up on :${PORT} (pid ${proc.pid})`);
        return proc;
      }
    } catch {
      /* not up */
    }
    await sleep(250);
  }
  await stopOwnedProcess(proc);
  throw new Error(`backend did not come up (see ${backendLog})`);
}
async function startGateway(publicUrl: string, memoryUrl?: string): Promise<Proc> {
  const fd = openSync(gatewayLog, "w");
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.GATEWAY_PORT = String(GATEWAY_PORT);
  env.DATABASE_URL = DB_URL;
  env.GATEWAY_PUBLIC_URL = publicUrl;
  env.PROVIDER_GATEWAY_SECRET = providerSigningSecret;
  env.TOOL_GATEWAY_SECRET = toolSigningSecret;
  env.SECRETS_ENCRYPTION_KEY = secretsEncryptionKey;
  if (memoryUrl !== undefined) env.MEMORY_API_URL = memoryUrl;
  let proc: Proc;
  try {
    proc = Bun.spawn(["bun", "src/gateway.ts"], {
      cwd: backendDir,
      env,
      stdout: fd,
      stderr: fd,
    });
  } finally {
    closeSync(fd);
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${GATEWAY_BASE}/api/health`)).ok) return proc;
    } catch {
      /* not up */
    }
    await sleep(250);
  }
  await stopOwnedProcess(proc);
  throw new Error(`gateway did not come up (see ${gatewayLog})`);
}
async function waitForPublicGateway(origin: string): Promise<void> {
  await waitForPublicHttp(`${origin}/api/health`, 90_000, tunnelLog);
}
function tailLog(path: string, lines = 30): void {
  try {
    const all = readFileSync(path, "utf8").trimEnd().split("\n");
    console.log(`  ── log tail (${path}) ──`);
    for (const l of all.slice(-lines)) console.log(`  │ ${l}`);
  } catch {
    /* none */
  }
}
async function api(path: string, body?: unknown, method = "POST"): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function waitForRun(runId: string, budgetMs: number): Promise<any> {
  const deadline = Date.now() + budgetMs;
  let row: any = null;
  while (Date.now() < deadline) {
    [row] = await sql`select id, status, summary, thread_id, sandbox_id from runs where id = ${runId}`;
    if (row && (row.status === "completed" || row.status === "failed")) return row;
    await sleep(1500);
  }
  return row;
}
async function eventsOf(runId: string, type: string): Promise<any[]> {
  return sql`select payload from provider_events where run_id = ${runId} and event_type = ${type}`;
}

async function cleanupSandboxes(): Promise<void> {
  if (!process.env.DAYTONA_API_KEY) return;
  console.log("\n── cleanup: deleting proof sandboxes ──");
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
  } catch {
    /* best-effort */
  }
  for (const id of ids) {
    try {
      const sb = await d.get(id).catch(() => null);
      if (sb) await d.delete(sb, 60, true); // wait: block until destroyed
      console.log(`  🗑  deleted sandbox ${id.slice(0, 12)}`);
    } catch (e) {
      console.log(`  ⚠️  could not delete ${id.slice(0, 12)}: ${(e as Error).message}`);
    }
  }
  for (const id of ids) {
    // Delete propagation can lag the call — verify with a few retries.
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      const sb = await d.get(id).catch(() => null);
      gone = !sb || (sb as { state?: string }).state === "destroyed";
      if (!gone) await sleep(2000);
    }
    check(`sandbox ${id.slice(0, 12)} deleted (API-verified gone)`, gone);
  }
}

/** Sweep the teal marker's L1 fact from whatever pool it landed in (best-effort). */
async function sweepMarker(): Promise<void> {
  const url = (process.env.MEMORY_API_URL ?? "").replace(/\/+$/, "");
  if (!url) return;
  const base = { team_id: POOL_TEAM, agent_id: process.env.MEMORY_AGENT_ID ?? "skynet-backend", user_id: POOL_USER };
  const h = { Authorization: `Bearer ${process.env.MEMORY_API_KEY ?? ""}`, "x-tdai-service-id": process.env.MEMORY_SERVICE_ID ?? "skynet", "Content-Type": "application/json" };
  const s = await fetch(`${url}/v3/atomic/search`, { method: "POST", headers: h, body: JSON.stringify({ ...base, query: MARKER, limit: 50 }) }).then((r) => r.json()).catch(() => null);
  const ids = (s?.data?.items ?? []).filter((i: any) => (i.content ?? "").includes(MARKER)).map((i: any) => i.id);
  if (ids.length) {
    await fetch(`${url}/v3/atomic/delete`, { method: "POST", headers: h, body: JSON.stringify({ ...base, ids }) }).catch(() => {});
    note(`swept ${ids.length} L1 marker fact(s)`);
  }
}

async function main(): Promise<void> {
  console.log(`TWO-SANDBOX MEMORY E2E — real Daytona + opencode(${MODEL}) + :8420, marker=${MARKER}`);
  console.log(`  DB=${DB} PORT=${PORT} backend-log=${backendLog}`);
  if (!process.env.DAYTONA_API_KEY) { console.error("ABORT: DAYTONA_API_KEY not set"); process.exit(2); }
  if (!process.env.MEMORY_API_URL) { console.error("ABORT: MEMORY_API_URL not set (need :8420)"); process.exit(2); }

  await recreateDb();
  let tunnel: { proc: Proc; origin: string } | null = null;
  let backend: Proc | null = null;
  let gateway: Proc | null = null;
  try {
    tunnel = await startTunnel();
    console.log(`  tunnel origin: ${tunnel.origin}`);
    backend = await startBackend(tunnel.origin);
    gateway = await startGateway(tunnel.origin);
    await waitForPublicGateway(tunnel.origin);

    // Safety: confirm the throwaway DB before ANY real work.
    const probe = await api("/api/runs", { prompt: "db-probe", engine: "mock", model: MODEL });
    const onThrowaway = (await sql`select 1 from runs where id = ${probe.body.id}`).length === 1;
    if (!onThrowaway) { console.error("ABORT: NOT on the throwaway DB"); process.exit(2); }
    note("safety probe: backend is on the throwaway DB");
    check(
      "public tunnel exposes only gateway routes",
      (await fetch(`${tunnel.origin}/api/runs`)).status === 404,
    );

    // ── Sandbox A: remember ─────────────────────────────────────────────────
    // A UNIQUE fact key (project passphrase), not "favourite color": the shared
    // dev-org pool already holds stale favourite-color facts from prior sessions,
    // which would make the recall ambiguous (this is the very memory-hygiene
    // collision the original bug was about). A unique key isolates the proof.
    const rememberPrompt = `Please use your memory tool to remember this durable fact about me: my project passphrase is ${MARKER}. Persist it, then confirm.`;
    const a = await api("/api/runs", { prompt: rememberPrompt, engine: "opencode", model: MODEL, memory_scope: "org" });
    check("run A accepted", a.status === 201 && !!a.body.id, `status=${a.status}`);
    const runA = a.body.id as string;
    note(`run A ${runA} (sandbox A) - waiting up to 8 min for the real turn…`);
    const rowA = await waitForRun(runA, 8 * 60 * 1000);
    check("run A reached terminal", rowA?.status === "completed" || rowA?.status === "failed", `status=${rowA?.status}`);

    const l0 = await eventsOf(runA, "memory.l0_accepted");
    const acceptedRef = l0.length > 0
      ? JSON.parse(l0[0].payload).refs?.[0]
      : undefined;
    const l0ok = typeof acceptedRef === "string" && acceptedRef.startsWith("tencent:l0:");
    check("sandbox A agent CALLED memory_remember -> Tencent L0 accepted", l0ok, l0.length ? `refs=${JSON.parse(l0[0].payload).refs}` : "no memory.l0_accepted event");

    // Provider-side confirmation: the fact is in Tencent L0 (not memory.md/Postgres).
    const memUrl = process.env.MEMORY_API_URL!.replace(/\/+$/, "");
    const l0search = await fetch(`${memUrl}/v3/conversation/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.MEMORY_API_KEY}`, "x-tdai-service-id": process.env.MEMORY_SERVICE_ID ?? "skynet", "Content-Type": "application/json" },
      body: JSON.stringify({ team_id: POOL_TEAM, agent_id: process.env.MEMORY_AGENT_ID ?? "skynet-backend", user_id: POOL_USER, query: MARKER, limit: 10 }),
    }).then((r) => r.json()).catch(() => null);
    check("fact is durable in Tencent L0 (provider truth)", JSON.stringify(l0search?.data?.messages ?? []).includes(MARKER));

    // ── Sandbox B: a DIFFERENT thread recalls it ────────────────────────────
    const b = await api("/api/runs", { prompt: "What is my project passphrase? Answer with just the passphrase.", engine: "opencode", model: MODEL, memory_scope: "org" });
    check("run B accepted", b.status === 201 && !!b.body.id, `status=${b.status}`);
    const runB = b.body.id as string;
    note(`run B ${runB} (sandbox B) - waiting up to 8 min…`);
    const rowB = await waitForRun(runB, 8 * 60 * 1000);
    check("run B reached terminal", rowB?.status === "completed" || rowB?.status === "failed", `status=${rowB?.status}`);
    check(
      "run B is a DIFFERENT thread/sandbox than A",
      !!rowA?.thread_id && !!rowB?.thread_id && rowA.thread_id !== rowB.thread_id && rowA.sandbox_id !== rowB.sandbox_id,
      `threadA=${String(rowA?.thread_id).slice(0, 8)} threadB=${String(rowB?.thread_id).slice(0, 8)} sbA=${String(rowA?.sandbox_id).slice(0, 8)} sbB=${String(rowB?.sandbox_id).slice(0, 8)}`,
    );

    const answerB = String(rowB?.summary ?? "");
    check("SANDBOX B ANSWERS THE MARKER (cross-sandbox recall)", answerB.toLowerCase().includes(MARKER.toLowerCase()), `answer="${answerB.slice(0, 200).replace(/\n/g, "\\n")}"`);
    // The recall came from Tencent (pre-turn context.retrieved and/or a memory_search).
    const ctx = await eventsOf(runB, "context.retrieved");
    const searched = await eventsOf(runB, "memory.searched");
    // Ledger payloads intentionally omit memory content. Prove that B recalled
    // the exact fact by matching A's provider receipt ref, not by weakening the
    // assertion to "some memory event happened" or leaking content into audit.
    const recallSawAcceptedRef =
      typeof acceptedRef === "string" &&
      [...ctx, ...searched].some((event) => {
        const refs = JSON.parse(event.payload).refs;
        return Array.isArray(refs) && refs.includes(acceptedRef);
      });
    check(
      "run B recall cites sandbox A's exact Tencent receipt",
      recallSawAcceptedRef,
      `context.retrieved=${ctx.length} memory.searched=${searched.length}`,
    );
    check("no memory_files table exists (Postgres is not the memory store)", (await sql`select to_regclass('public.memory_files') as t`)[0].t === null);
    note(`recall event receipt-hit: ${recallSawAcceptedRef}`);
    note(`A answer: "${String(rowA?.summary ?? "").slice(0, 160).replace(/\n/g, "\\n")}"`);
    note(`B answer: "${answerB.slice(0, 160).replace(/\n/g, "\\n")}"`);

    // ── Phase 3: recall OUTAGE - the turn still completes, honestly (12.5) ────
    note("phase 3: restarting the backend + gateway with memory pointed at a DEAD host…");
    await stopOwnedProcesses([backend, gateway]);
    const deadMemoryUrl = "http://127.0.0.1:9";
    backend = await startBackend(tunnel.origin, deadMemoryUrl);
    gateway = await startGateway(tunnel.origin, deadMemoryUrl);
    await waitForPublicGateway(tunnel.origin);
    const cRun = await api("/api/runs", {
      prompt: "Use your memory_search tool to look up my project passphrase, then tell me what you found.",
      engine: "opencode",
      model: MODEL,
      memory_scope: "org",
    });
    check("run C accepted (memory down)", cRun.status === 201 && !!cRun.body.id, `status=${cRun.status}`);
    const runC = cRun.body.id as string;
    note(`run C ${runC} (sandbox C, memory unavailable) - waiting up to 8 min…`);
    const rowC = await waitForRun(runC, 8 * 60 * 1000);
    check("run C COMPLETED despite memory being unavailable (the turn is not blocked)", rowC?.status === "completed", `status=${rowC?.status}`);
    const cFailed = await eventsOf(runC, "memory.failed");
    const cSearchFailed = cFailed.some((e) => JSON.parse(e.payload).op === "search");
    check("memory outage surfaced as memory.failed op:search (not a fake 0-hit)", cSearchFailed, `memory.failed events=${cFailed.length}`);
  } finally {
    await stopOwnedProcesses([backend, gateway, tunnel?.proc]);
    try {
      await cleanupSandboxes();
    } catch (error) {
      check("proof sandbox cleanup completed", false, (error as Error).message);
    }
    await sweepMarker().catch(() => {});
    await dropDb();
  }

  console.log(`\n══ ${pass} PASS / ${fail} FAIL ══`);
  if (fail > 0) { tailLog(backendLog, 50); tailLog(gatewayLog, 30); tailLog(tunnelLog, 10); }
  console.log(fail === 0 ? "\n✅ TWO-SANDBOX MEMORY E2E PASSED" : `\n❌ E2E FAILED (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
