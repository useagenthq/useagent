/**
 * LIVE proof for Slice A (mem_op.md 0.2) — a REAL opencode run in a REAL Daytona
 * sandbox answers a question it can ONLY answer by calling knowledge_search through
 * the trusted gateway. The sandbox reaches THIS backend over a cloudflared quick
 * tunnel (the sandbox holds only the run-scoped token; the gateway derives org
 * server-side). MANUAL + costs real Daytona + tokens. Deletes every sandbox it makes.
 *
 *   bun run test/manual/knowledge-gateway-live.ts
 *
 * Needs backend/.env with DAYTONA_API_KEY + ANTHROPIC_API_KEY, and `cloudflared`
 * on PATH. Isolated: throwaway DB skynet_kbgw_live, own backend on :3415.
 */
import { openSync, readFileSync } from "node:fs";
import { Daytona } from "@daytona/sdk";
import postgres from "postgres";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB = "skynet_kbgw_live";
const DB_URL = `postgres://postgres@localhost:5432/${DB}`;
const PORT = 3415;
const BASE = `http://localhost:${PORT}`;
const MODEL = "claude-haiku-4-5";
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const backendDir = new URL("../..", import.meta.url).pathname;
const backendLog = `${scratch}/kbgw-live-backend.log`;
const tunnelLog = `${scratch}/kbgw-live-tunnel.log`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};
const note = (m: string) => console.log(`  · ${m}`);

const sql = postgres(DB_URL, { max: 4 });

async function recreateDb() {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
}
async function dropDb() {
  await sql.end().catch(() => {});
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await admin.end();
}

async function startTunnel(): Promise<{ proc: any; url: string }> {
  const fd = openSync(tunnelLog, "a");
  const proc = Bun.spawn(
    ["cloudflared", "tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`],
    { stdout: fd, stderr: fd },
  );
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(readFileSync(tunnelLog, "utf8"));
      if (m) return { proc, url: m[0] };
    } catch {
      /* not written yet */
    }
    await sleep(500);
  }
  throw new Error(`cloudflared did not print a URL (see ${tunnelLog})`);
}

async function startBackend(publicUrl: string): Promise<any> {
  const fd = openSync(backendLog, "a");
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: backendDir,
    env: {
      ...process.env, // carries .env (DAYTONA/ANTHROPIC/OPENROUTER)
      PORT: String(PORT),
      DATABASE_URL: DB_URL,
      SKYNET_DEV_MODE: "true",
      FRONTEND_ORIGIN: "http://localhost:3400",
      MEMORY_API_URL: "", // disable memory recall — keep the proof about knowledge
      TOOL_GATEWAY_PUBLIC_URL: publicUrl,
      TOOL_GATEWAY_TOKEN_TTL_MS: String(30 * 60 * 1000),
    },
    stdout: fd,
    stderr: fd,
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return proc;
    } catch {
      /* not up */
    }
    await sleep(250);
  }
  throw new Error(`backend did not come up (see ${backendLog})`);
}

async function api(path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function cleanupSandboxes() {
  if (!process.env.DAYTONA_API_KEY) return;
  console.log("\n── cleanup: deleting live sandbox(es) ──");
  const runIds = new Set((await sql`select id from runs`.catch(() => [])).map((r: any) => r.id as string));
  const ids = new Set(
    (await sql`select distinct sandbox_id from runs where sandbox_id is not null`.catch(() => [])).map((r: any) => r.sandbox_id as string),
  );
  const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY!, target: process.env.DAYTONA_TARGET ?? "us" });
  try {
    for await (const sb of d.list()) {
      const label = (sb as { labels?: Record<string, string> }).labels?.["skynet-run"];
      if (label && runIds.has(label)) ids.add(sb.id);
    }
  } catch {
    /* best effort */
  }
  let deleted = 0;
  for (const id of ids) {
    try {
      await (await d.get(id)).delete();
      deleted++;
      console.log(`  🗑  deleted sandbox ${id.slice(0, 12)}`);
    } catch (e) {
      console.log(`  ⚠️  could not delete ${id.slice(0, 12)}: ${(e as Error).message}`);
    }
  }
  console.log(`  cleanup: ${deleted}/${ids.size} sandbox(es) deleted`);
}

async function main() {
  if (!process.env.DAYTONA_API_KEY) {
    console.error("ABORT: DAYTONA_API_KEY not set");
    process.exit(2);
  }
  console.log("LIVE Slice A — real opencode calls knowledge_search over a cloudflared tunnel");

  await recreateDb();
  const tunnel = await startTunnel();
  note(`tunnel: ${tunnel.url}`);
  const backend = await startBackend(tunnel.url);
  note(`backend up on :${PORT} (pid ${backend.pid}); TOOL_GATEWAY_PUBLIC_URL=${tunnel.url}`);

  try {
    // Safety: confirm we're on the throwaway DB.
    const probe = await api("/api/runs", { prompt: "db-probe", engine: "mock", model: MODEL });
    const onThrowaway = (await sql`select 1 from runs where id = ${probe.id}`).length === 1;
    check("backend is on the throwaway DB", onThrowaway);
    if (!onThrowaway) throw new Error("not on throwaway DB — aborting");

    // Seed a UNIQUE fact only the tool can reveal.
    const code = `RB-${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    const label = `nimbus`;
    const text =
      `Deployment rollback codes. The rollback authorization code for the ${label} ` +
      `service is ${code}. To roll back ${label}, run 'skynet rollback ${label} --code ${code}'. ` +
      `This value lives only in the knowledge base.`;
    const ing = await api("/api/knowledge/ingest", {
      meta: { source_type: "document", external_id: `live-${code}`, connector_instance_id: "kbgw:live", source_url: "https://ex/kbgw" },
      text,
    });
    check("unique fact ingested into the org KB", ing.status === "stored" || ing.status === "skipped", `status=${ing.status} code=${code}`);

    // Real opencode run that MUST use the tool to answer.
    const marker = `askrb-${crypto.randomUUID().slice(0, 6)}`;
    const prompt =
      `${marker} You do NOT know the rollback authorization code for the ${label} service — it is ` +
      `stored only in the organization knowledge base. Call the knowledge_search tool ` +
      `(query for the ${label} rollback authorization code), then reply with ONLY the code, nothing else.`;
    const run = await api("/api/runs", { prompt, engine: "opencode", model: MODEL });
    note(`run ${run.id} created; waiting for the real sandbox turn (up to 6 min)…`);

    const deadline = Date.now() + 6 * 60 * 1000;
    let row: any = null;
    while (Date.now() < deadline) {
      [row] = await sql`select id, status, summary, sandbox_id, engine_session_id from runs where id = ${run.id}`;
      if (row && (row.status === "completed" || row.status === "failed")) break;
      await sleep(3000);
    }
    check("run reached a terminal state", row?.status === "completed" || row?.status === "failed", `status=${row?.status} sandbox=${row?.sandbox_id?.slice(0, 8)}`);

    // THE proof: a knowledge.retrieved ledger frame means the sandbox agent actually
    // CALLED the gateway (server-side), and the answer contains the tool-only code.
    const ledger = await sql`select payload from provider_events where run_id = ${run.id} and event_type = 'knowledge.retrieved'`;
    check("agent CALLED the gateway (knowledge.retrieved ledger frame exists)", ledger.length > 0, `${ledger.length} frame(s)`);
    if (ledger.length > 0) {
      const p = JSON.parse(ledger[0].payload as string);
      note(`ledger: tool=${p.tool} query="${String(p.query).slice(0, 60)}" items=${p.itemCount} org=${p.scope?.orgId}`);
    }
    const answer = String(row?.summary ?? "");
    check("the run's answer contains the tool-only code", answer.includes(code), `code=${code} answer="${answer.slice(0, 80)}"`);
  } catch (e) {
    check("live proof threw", false, (e as Error).message);
  } finally {
    backend.kill(9);
    await backend.exited.catch(() => {});
    await cleanupSandboxes().catch((e) => console.log(`  cleanup error: ${(e as Error).message}`));
    tunnel.proc.kill(9);
    await dropDb();
  }

  console.log(`\n${fail === 0 ? "✅ LIVE SLICE A PROOF PASSED" : `❌ LIVE PROOF FAILED (${fail})`}`);
  if (fail > 0) {
    try {
      console.log(`  ── backend log tail (${backendLog}) ──`);
      for (const l of readFileSync(backendLog, "utf8").trimEnd().split("\n").slice(-25)) console.log(`  │ ${l}`);
    } catch { /* no log */ }
  }
  process.exit(fail === 0 ? 0 : 1);
}

await main();
