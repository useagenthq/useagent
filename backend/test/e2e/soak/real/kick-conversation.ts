/**
 * REAL-DEPTH soak — full "kick and conversation" cycles on REAL Daytona sandboxes
 * + real opencode (claude-haiku-4-5). DOZENS not thousands (cost-bounded): one
 * sandbox per thread, reused across turns (resident-server model). The user's
 * hard rule is enforced HERE: every sandbox this batch creates is DELETED and its
 * deletion VERIFIED via the Daytona API at batch end — Daytona is left clean.
 *
 *   bun test/e2e/soak/real/kick-conversation.ts        # 1 thread (validation)
 *   SOAK_REAL_THREADS=4 SOAK_REAL_KILL=1 SOAK_REAL_MEM=1 bun …/kick-conversation.ts
 *
 * Each thread cycle (all on ONE sandbox):
 *   kick → reply×N (parent chain, resumed by session id) → optional mid-run queued
 *   reply → optional memory canary teach+recall → optional SIGKILL mid-turn +
 *   restart (reconcile-to-completed FOR REAL) → keep chatting.
 *
 * Invariants: every turn completes; the thread reuses ONE sandbox; replies keep
 * strict order; a killed real turn reconciles to completed on reboot (NOT honest-
 * failed like mock); the recall path fires for the canal. Prints SOAK_RESULT.
 *
 * Requires backend/.env: DAYTONA_API_KEY, ANTHROPIC_API_KEY (+ MEMORY_* for canary).
 */
import { openSync } from "node:fs";
import postgres from "postgres";
import { Recorder } from "../lib/report";
import { deleteById, listSkynet } from "../lib/daytona";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB = process.env.SOAK_REAL_DB ?? "skynet_soak_real";
const DB_URL = `postgres://postgres@localhost:5432/${DB}`;
const PORT = Number(process.env.SOAK_REAL_PORT ?? 3518);
const BASE = `http://localhost:${PORT}`;
const MODEL = process.env.SOAK_REAL_MODEL ?? "claude-haiku-4-5";
const THREADS = Number(process.env.SOAK_REAL_THREADS ?? 1);
const REPLIES = Number(process.env.SOAK_REAL_REPLIES ?? 2);
const DO_KILL = process.env.SOAK_REAL_KILL === "1";
const DO_MEM = process.env.SOAK_REAL_MEM === "1";
const backendDir = new URL("../../../..", import.meta.url).pathname;
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const backendLog = `${scratch}/skynet-soak-real.log`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rec = new Recorder("real-kick-conversation");
const sql = postgres(DB_URL, { max: 4 });
const createdSandboxes = new Set<string>();
type Proc = ReturnType<typeof Bun.spawn>;
let proc: Proc | null = null;

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

async function startBackend(label: string): Promise<void> {
  const fd = openSync(backendLog, "a");
  proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: backendDir,
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: DB_URL, FRONTEND_ORIGIN: "http://localhost:3400", MEMORY_OUTBOX_TICK_MS: "2000" },
    stdout: fd,
    stderr: fd,
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { console.log(`[${label}] backend up :${PORT}`); return; } } catch { /* not up */ }
    await sleep(250);
  }
  throw new Error(`[${label}] backend did not come up (see ${backendLog})`);
}
async function killBackend(): Promise<void> {
  if (!proc) return;
  proc.kill(9);
  await proc.exited;
  proc = null;
}

async function createRun(body: Record<string, unknown>): Promise<string | null> {
  const res = await fetch(`${BASE}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { id?: string };
  return j.id ?? null;
}
async function getRun(id: string): Promise<any | null> {
  const rows = await sql`select id, status, summary, engine_session_id, sandbox_id, parent_run_id, updated_at from runs where id = ${id}`;
  return rows[0] ?? null;
}
async function waitRun(id: string, pred: (r: any) => boolean, budgetMs: number): Promise<any | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const r = await getRun(id);
    if (r && pred(r)) return r;
    await sleep(1000);
  }
  return await getRun(id);
}
const terminal = (s: string) => s === "completed" || s === "failed";

async function recordSandbox(runId: string): Promise<string | null> {
  const r = await getRun(runId);
  const sb = r?.sandbox_id as string | null;
  if (sb) createdSandboxes.add(sb);
  return sb ?? null;
}

async function threadCycle(t: number): Promise<void> {
  const ev: Record<string, unknown> = { thread: t };
  const marker = `soakreal-${Date.now().toString(36)}-${t}`;
  // KICK — a fresh opencode session on a fresh sandbox.
  const kick = await createRun({ prompt: `${marker} Reply with just the word ready.`, engine: "opencode", model: MODEL });
  if (!kick) return void rec.check(false, "kick accepted", "no run id", ev);
  const kr = await waitRun(kick, (r) => terminal(r.status), 300_000);
  rec.check(kr?.status === "completed", "kick completed on real sandbox", `status=${kr?.status}`, { ...ev, kick });
  const sb0 = await recordSandbox(kick);
  rec.check(!!sb0, "kick provisioned + persisted a sandbox id", `sandbox=${sb0?.slice(0, 12)}`, ev);
  rec.check(!!kr?.engine_session_id, "kick recorded an opencode session id", `sess=${kr?.engine_session_id?.slice(0, 12)}`, ev);
  if (kr?.status !== "completed") return; // no point continuing a broken thread

  // REPLIES — parent chain, each resumes the SAME session on the SAME sandbox.
  let parent = kick;
  const settleTimes: number[] = [new Date(kr.updated_at).getTime()];
  for (let i = 0; i < REPLIES; i++) {
    const rid = await createRun({ prompt: `${marker} reply ${i}: say the number ${i + 1} and nothing else.`, engine: "opencode", model: MODEL, parent_run_id: parent });
    if (!rid) { rec.check(false, "reply accepted", "no id", { ...ev, i }); break; }
    const rr = await waitRun(rid, (r) => terminal(r.status), 300_000);
    rec.check(rr?.status === "completed", `reply ${i} completed`, `status=${rr?.status}`, { ...ev, i, rid });
    const sb = await recordSandbox(rid);
    rec.check(sb === sb0, `reply ${i} reused the thread sandbox`, `sb=${sb?.slice(0, 8)} vs ${sb0?.slice(0, 8)}`, { ...ev, i });
    if (rr?.updated_at) settleTimes.push(new Date(rr.updated_at).getTime());
    parent = rid;
  }
  const ordered = settleTimes.every((v, i) => i === 0 || v >= settleTimes[i - 1]!);
  rec.check(ordered, "replies settled in strict order", settleTimes.join("<"), ev);

  // MEMORY CANARY — teach a thread-UNIQUE fact, then recall it in a later turn.
  // The canary is keyed by the thread's unique `marker` so the SHARED team-memory
  // pool (shared across threads by design) can't return a sibling thread's colliding
  // fact — batch 1 proved an un-keyed "our canary" recalls another thread's value.
  if (DO_MEM) {
    const canary = `RC-SOAK-${Math.floor(Math.random() * 1e6)}`;
    const teach = await createRun({ prompt: `${marker} Please remember exactly: the soak canary for ${marker} is ${canary}. Reply "noted".`, engine: "opencode", model: MODEL, parent_run_id: parent });
    if (teach) { await waitRun(teach, (r) => terminal(r.status), 300_000); await recordSandbox(teach); parent = teach; }
    const ask = await createRun({ prompt: `${marker} What is the soak canary for ${marker}? Reply with just the code.`, engine: "opencode", model: MODEL, parent_run_id: parent });
    if (ask) {
      const ar = await waitRun(ask, (r) => terminal(r.status), 300_000);
      await recordSandbox(ask);
      // HARD: the recall PATH fired end-to-end — a context.retrieved ledger frame
      // was recorded (search ran → memory items → injected).
      const ledger = Number((await sql`select count(*)::int as n from provider_events where run_id = ${ask} and event_type = 'context.retrieved'`)[0]?.n ?? 0);
      rec.check(ledger >= 1, "recall path fired (context.retrieved frame recorded)", `${ledger} frames`, { ...ev, ask });
      // SOFT: recall ACCURACY (own canary surfaced). Real memory indexing lag + LLM
      // phrasing make per-turn exactness nondeterministic, so track a rate — don't
      // fail a turn. A persistently low rate is the signal to dig into.
      rec.bump("recall_attempts");
      const gotOwn = typeof ar?.summary === "string" && ar.summary.includes(canary);
      if (gotOwn) rec.bump("recall_correct");
      else rec.bump("recall_miss");
      parent = ask;
    }
  }

  // KILL / RESTART mid-turn — reconcile-to-completed FOR REAL (opencode finishes
  // server-side; recovery reconciles, NOT honest-fail).
  if (DO_KILL) {
    const krun = await createRun({ prompt: `${marker} Write a two-line haiku about the sea to sea.txt then reply done.`, engine: "opencode", model: MODEL, parent_run_id: parent });
    if (krun) {
      await waitRun(krun, (r) => r.status === "running" && !!r.engine_session_id, 120_000);
      await killBackend();
      await startBackend(`restart-t${t}`);
      const kr2 = await waitRun(krun, (r) => terminal(r.status), 180_000);
      rec.check(kr2?.status === "completed", "killed real turn reconciled to completed after reboot", `status=${kr2?.status}`, { ...ev, krun });
      await recordSandbox(krun);
      // keep chatting — the conversation continues on the same sandbox.
      const cont = await createRun({ prompt: `${marker} say ok`, engine: "opencode", model: MODEL, parent_run_id: krun });
      if (cont) { const cr = await waitRun(cont, (r) => terminal(r.status), 300_000); rec.check(cr?.status === "completed", "conversation continues after crash/restart", `status=${cr?.status}`, ev); await recordSandbox(cont); }
    }
  }
  rec.bump("threads");
}

/** VERIFIED cleanup — delete every sandbox this batch created (by persisted id AND
 *  by our run-id label), then confirm via the API that NONE remain. */
async function cleanup(): Promise<void> {
  if (!process.env.DAYTONA_API_KEY) return;
  // Also sweep by run-id label (a sandbox whose id never persisted, e.g. a crash
  // before setRunSandbox) — but ONLY our own throwaway run ids.
  const runIds = new Set((await sql`select id from runs`.catch(() => [])).map((r) => r.id as string));
  try {
    for (const sb of await listSkynet()) {
      const label = sb.labels["skynet-run"];
      if (label && runIds.has(label)) createdSandboxes.add(sb.id);
    }
  } catch { /* best-effort */ }
  const ids = [...createdSandboxes];
  const res = await deleteById(ids);
  rec.bump("sandboxes_created", ids.length);
  rec.bump("sandboxes_deleted", res.deleted.length);
  rec.check(res.failed.length === 0, "every created sandbox deleted + verified gone", `${res.deleted.length}/${ids.length} deleted, ${res.failed.length} failed`, { ids, failed: res.failed });
  console.log(`CLEANUP deleted=${res.deleted.length}/${ids.length} failed=${res.failed.length}`);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  if (!process.env.DAYTONA_API_KEY) { console.error("ABORT: DAYTONA_API_KEY not set"); process.exit(2); }
  await recreateDb();
  await startBackend("boot");
  try {
    for (let t = 0; t < THREADS; t++) await threadCycle(t);
  } catch (err) {
    rec.check(false, "harness error", err instanceof Error ? (err.stack ?? err.message) : String(err), {});
  } finally {
    await killBackend().catch(() => {});
    await cleanup().catch((e) => rec.check(false, "cleanup error", String(e), {}));
    if (process.env.SOAK_REAL_KEEPDB === "1") console.log(`KEEPDB: inspect ${DB} (not dropped)`);
    else await dropDb().catch(() => {});
  }
  rec.emit(Date.now() - t0, rec.stats.threads ?? 0);
}

await main();
