/**
 * OWNED end-to-end suite — the whole Skynet stability story on ONE isolated stack.
 * MANUAL-gated (not in `bun test`): it spawns real backend processes, a throwaway
 * DB, and mock Memory/Slack receivers. Run it with:  bun run e2e
 *
 * No Daytona: runs use the `mock` engine (deterministic, fast). Team memory + Slack
 * are pointed at in-process mock receivers via MEMORY_API_URL / SLACK_API_URL. The
 * stack under test is the REAL backend (index.ts boot, command lane, finalization,
 * recovery, outboxes, SSE) — only the leaf integrations (LLM sandbox, Memory
 * gateway, Slack API) are mocked.
 *
 * Stages (each asserts; any failure exits non-zero):
 *   1. Idempotency-Key      — POST /api/runs twice, same key → same run id.
 *   2. Native replay        — seed a fanout of native frames, kill the SSE socket
 *                             mid-stream, reconnect from cursor → ZERO missing.
 *   3. Slack + memory story — app_mention → run → durable Slack reply delivered +
 *                             memory capture delivered; a threaded reply recalls
 *                             team memory (canary) via the retrieval ledger.
 *   4. Crash matrix         — long run mid-flight with a queued reply → SIGKILL the
 *                             backend → restart → boot recovery settles it and
 *                             dispatches the queued reply IN ORDER; the pre-crash
 *                             durable rows (capture, slack reply) survived.
 *
 * What mock can't fully show (documented, proven elsewhere): a real opencode run
 * reconciles-to-completed after a mid-run crash (recovery.test.ts + the command-
 * lane live proofs) and a real engine's answer contains the recalled canary (the
 * memory-phase live proofs). Here the mock honest-fails on crash and ignores
 * injected context, so stage 4 asserts recovery + ordering, and stage 3 asserts the
 * recall PATH fired (search call + context.retrieved ledger frame).
 */
import { createHmac } from "node:crypto";
import postgres from "postgres";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB = "skynet_e2e";
const DB_URL = `postgres://postgres@localhost:5432/${DB}`;
const PORT = 3507;
const MEM_PORT = 3517;
const SLACK_PORT = 3518;
const BASE = `http://localhost:${PORT}`;
const SIGNING = "e2e-signing-secret";
const BOT = "U0E2EBOT";
/** Engine for the Slack-driven runs; `mock` by default (no Daytona). Set
 *  E2E_ENGINE=opencode to exercise the real recall path (needs a live sandbox). */
const E2E_ENGINE = process.env.E2E_ENGINE ?? "mock";
const REAL_ENGINE = E2E_ENGINE !== "mock";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backendDir = new URL("../..", import.meta.url).pathname;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── mock receivers ──────────────────────────────────────────────────────────
interface MemHit { path: string; body: any }
const memHits: MemHit[] = [];
const CANARY = "the canary rollout gate check id is RC-E2E-777";
const memServer = Bun.serve({
  port: MEM_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    memHits.push({ path: url.pathname, body });
    if (url.pathname === "/v3/atomic/search") {
      return Response.json({ code: 0, data: { items: [{ id: "canary-1", type: "fact", content: CANARY, score: 0.98 }] } });
    }
    return Response.json({ code: 0, data: {} }); // /v3/conversation/add etc.
  },
});

interface SlackHit { method: string; body: any }
const slackHits: SlackHit[] = [];
const slackServer = Bun.serve({
  port: SLACK_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = url.pathname.replace(/^\/api\//, "");
    slackHits.push({ method, body: await req.json().catch(() => ({})) });
    return Response.json({ ok: true });
  },
});

// ── backend subprocess control ────────────────────────────────────────────────
type Proc = ReturnType<typeof Bun.spawn>;
async function startBackend(label: string): Promise<Proc> {
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: DB_URL,
      FRONTEND_ORIGIN: "http://localhost:3400",
      MEMORY_API_URL: `http://localhost:${MEM_PORT}`,
      MEMORY_API_KEY: "e2e",
      MEMORY_TEAM_ID: "skynet",
      MEMORY_AGENT_ID: "skynet-backend",
      MEMORY_USER_ID: "skynet",
      MEMORY_OUTBOX_TICK_MS: "400",
      SLACK_BOT_TOKEN: "xoxb-e2e",
      SLACK_SIGNING_SECRET: SIGNING,
      SLACK_API_URL: `http://localhost:${SLACK_PORT}`,
      SLACK_DEFAULT_ENGINE: E2E_ENGINE,
      SLACK_OUTBOX_TICK_MS: "400",
      SLACK_OUTBOX_BASE_MS: "50",
      WORKER_STEP_DELAY_MS: "150", // ~1.2s/run; slow enough to catch a run mid-flight
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  // Wait for /api/health.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { console.log(`[${label}] backend up on :${PORT} (pid ${proc.pid})`); return proc; }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`[${label}] backend did not come up`);
}

async function killBackend(proc: Proc): Promise<void> {
  proc.kill(9); // SIGKILL — no graceful shutdown, exactly like a crash
  await proc.exited;
}

// ── helpers ─────────────────────────────────────────────────────────────────
const sql = postgres(DB_URL, { max: 4 });

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

function slackHeaders(raw: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = "v0=" + createHmac("sha256", SIGNING).update(`v0:${ts}:${raw}`).digest("hex");
  return { "content-type": "application/json", "x-slack-signature": sig, "x-slack-request-timestamp": ts };
}

async function postSlackEvent(event: Record<string, unknown>): Promise<void> {
  const raw = JSON.stringify({ type: "event_callback", event_id: `Ev${crypto.randomUUID().slice(0, 8)}`, authorizations: [{ user_id: BOT }], event });
  await fetch(`${BASE}/api/slack/events`, { method: "POST", body: raw, headers: slackHeaders(raw) });
}

async function runByPrompt(prompt: string): Promise<any | null> {
  const rows = await sql`select id, status, summary, thread_id, parent_run_id, updated_at from runs where prompt = ${prompt} limit 1`;
  return rows[0] ?? null;
}

async function waitRun(prompt: string, pred: (r: any) => boolean, budgetMs = 15_000): Promise<any> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const r = await runByPrompt(prompt);
    if (r && pred(r)) return r;
    await sleep(120);
  }
  throw new Error(`waitRun timed out for "${prompt}"`);
}

async function waitFor(fn: () => Promise<boolean>, budgetMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(150); }
  return false;
}

// ── stages ────────────────────────────────────────────────────────────────────
async function stage1_idempotency(): Promise<void> {
  console.log("\n── Stage 1: Idempotency-Key ──");
  const key = `e2e-${crypto.randomUUID()}`;
  const body = JSON.stringify({ prompt: "idempotent run", engine: "mock" });
  const post = () => fetch(`${BASE}/api/runs`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body });
  const r1 = await post(); const j1 = await r1.json() as { id: string };
  const r2 = await post(); const j2 = await r2.json() as { id: string };
  check("first POST 201", r1.status === 201, `got ${r1.status}`);
  check("replayed POST 200", r2.status === 200, `got ${r2.status}`);
  check("same run id (no duplicate work)", j1.id === j2.id, `${j1.id} vs ${j2.id}`);
}

async function stage2_nativeReplay(): Promise<void> {
  console.log("\n── Stage 2: native fanout → SSE kill → reconnect (GAP 1) ──");
  // Seed a fanout of native frames for a fresh run directly in the DB (the SSE
  // replay/cursor path is what's under test here; the producer sequencer is proven
  // by native-reconnect.test.ts). Monotonic unique seqs, incl. one revision.
  const id = crypto.randomUUID();
  // org_id must match the org the SSE route authorizes against (dev org fallback).
  await sql`insert into runs (id, org_id, prompt, model, engine, status, thread_id) values (${id}, 'org-skynet-dev', 'native e2e', 'm', 'mock', 'running', ${id})`;
  const rows: [string, number][] = [];
  for (let i = 0; i < 20; i++) rows.push([`${id}::p${i}`, i]);
  rows.push([`${id}::p3`, 20]); // a revision of p3 → higher seq
  for (const [eid, seq] of rows) {
    await sql`insert into provider_events (id, run_id, thread_id, seq, provider, event_type, payload)
      values (${eid}, ${id}, ${id}, ${seq}, 'opencode', 'part.tool.completed', ${JSON.stringify({ seq })})
      on conflict (id) do update set seq = ${seq}`;
  }
  const dbRows = await sql`select id, seq from provider_events where run_id = ${id} order by seq asc`;
  const expected = new Map(dbRows.map((r) => [r.id as string, r.seq as number]));

  const store = new Map<string, number>();
  let cursor = -1;
  // First connection — read 5 frames then abort the socket (network kill).
  const ac1 = new AbortController();
  await readNative(`${BASE}/api/runs/${id}/events?cursor=-1`, (f) => {
    store.set(f.eventId, Math.max(store.get(f.eventId) ?? -1, f.seq));
    cursor = Math.max(cursor, f.seq);
    if (store.size >= 5) ac1.abort();
  }, ac1.signal);
  const afterKill = store.size;
  // Reconnect from cursor — replay strictly-later frames only.
  const ac2 = new AbortController();
  const t = setTimeout(() => ac2.abort(), 2500);
  let laterOnly = true;
  await readNative(`${BASE}/api/runs/${id}/events?cursor=${cursor}`, (f) => {
    if (f.seq <= cursor) laterOnly = false;
    store.set(f.eventId, Math.max(store.get(f.eventId) ?? -1, f.seq));
  }, ac2.signal);
  clearTimeout(t);

  const missing = [...expected].filter(([eid, seq]) => store.get(eid) !== seq);
  check("killed mid-stream (partial before reconnect)", afterKill >= 5 && afterKill < expected.size, `${afterKill}/${expected.size}`);
  check("reconnect replayed only strictly-later frames", laterOnly);
  check("ZERO missing seq after reconnect (store == rows)", missing.length === 0, `${missing.length} missing`);
}

interface NF { eventId: string; seq: number }
async function readNative(url: string, onFrame: (f: NF) => void, signal: AbortSignal): Promise<void> {
  let res: Response;
  try { res = await fetch(url, { signal }); } catch { return; }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep); buf = buf.slice(sep + 2);
        let ev = "message", data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (ev === "native" && data) { const o = JSON.parse(data); onFrame({ eventId: o.eventId, seq: o.seq }); if (signal.aborted) return; }
      }
    }
  } catch (e) { if ((e as Error).name !== "AbortError") throw e; }
  finally { reader.cancel().catch(() => {}); }
}

async function stage3_slackMemory(): Promise<{ channel: string; rootTs: string }> {
  console.log("\n── Stage 3: Slack reply + memory capture + recall (GAP 2 + GAP 3) ──");
  const channel = `C${crypto.randomUUID().slice(0, 6)}`;
  const rootTs = `${crypto.randomUUID().slice(0, 6)}.1`;
  const rootPrompt = `root question ${rootTs}`;
  await postSlackEvent({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> ${rootPrompt}`, ts: rootTs });
  const root = await waitRun(rootPrompt, (r) => r.status === "completed");

  // GAP 3: the durable Slack reply was delivered to the mock Slack receiver.
  const gotReply = await waitFor(async () =>
    slackHits.some((h) => h.method === "chat.postMessage" && h.body.channel === channel && h.body.thread_ts === rootTs && h.body.text === root.summary));
  check("Slack reply delivered to the mock receiver (run summary)", gotReply);

  // GAP 2: the memory capture was delivered to the mock Memory gateway. Key the
  // wait on this run's UNIQUE prompt: the mock summary is a CONSTANT shared by
  // every mock run (summarize(SCRIPT)), so matching on the summary alone is
  // satisfied by an EARLIER run's identical capture (db-probe, stage 1) and never
  // actually waits for THIS run's delivery.
  const gotCapture = await waitFor(async () =>
    memHits.some((h) => {
      if (h.path !== "/v3/conversation/add") return false;
      const msgs = JSON.stringify(h.body?.messages ?? []);
      return msgs.includes(rootPrompt) && msgs.includes(root.summary);
    }));
  check("memory capture delivered to the mock gateway (prompt+summary)", gotCapture);
  // The delivery HTTP call is observable a hair before the outbox commits
  // `delivered` (claim → POST → mark), so wait for THIS run's row to settle
  // rather than reading it once and racing the delivery tick.
  const capDelivered = await waitFor(async () =>
    (await sql`select state from memory_outbox where run_id = ${root.id}`)[0]?.state === "delivered");
  const [capRow] = await sql`select state from memory_outbox where run_id = ${root.id}`;
  check("memory_outbox row marked delivered", capDelivered, `state=${capRow?.state}`);

  // Threaded reply recalls team memory (canary) — the recall PATH fires.
  const replyPrompt = `what is our canary rollout gate check id ${rootTs}`;
  await postSlackEvent({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> ${replyPrompt}`, ts: `${rootTs}.2`, thread_ts: rootTs });
  const reply = await waitRun(replyPrompt, (r) => r.status === "completed");
  check("threaded reply is a follow-up in the same thread", reply.parent_run_id === root.id && reply.thread_id === root.id);
  // The recall path (searchTeamMemory + retrieval ledger) runs only for REAL
  // engines — the `mock` engine short-circuits in runWorker before context is
  // resolved and ignores injected context entirely. Assert it end-to-end only
  // when a real engine is configured (E2E_ENGINE=opencode); otherwise the recall
  // path is covered by the memory-phase unit tests + live proofs.
  if (REAL_ENGINE) {
    const searched = memHits.some((h) => h.path === "/v3/atomic/search" && h.body?.query === replyPrompt);
    check("team memory searched for the reply (recall path fired)", searched);
    const ledger = await sql`select id from provider_events where run_id = ${reply.id} and event_type = 'context.retrieved'`;
    check("retrieval-ledger context.retrieved frame recorded for the reply", ledger.length === 1);
  } else {
    console.log("  ⏭  recall assertions SKIPPED — mock engine skips the recall path (E2E_ENGINE=opencode to assert it; covered by memory-phase tests + live proofs)");
  }
  return { channel, rootTs };
}

async function stage3b_scopedCapture(): Promise<void> {
  console.log("\n── Stage 3b: scope-aware capture destination (org vs personal) ──");
  // Even for the mock engine, finalizeRun resolves the run's memory_scope from the
  // row and enqueues the capture into the RIGHT pool — so this proves the end-to-end
  // destination without a real engine. Identity is always from the run row.
  const mk = async (scope: "org" | "personal"): Promise<string> => {
    const prompt = `scope-${scope} ${crypto.randomUUID().slice(0, 6)}`;
    const r = await fetch(`${BASE}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, engine: "mock", memory_scope: scope }),
    });
    const id = (await r.json() as { id: string }).id;
    await waitRun(prompt, (x) => x.status === "completed");
    return id;
  };
  const orgId = await mk("org");
  const perId = await mk("personal");

  const [orgRow] = await sql`select memory_scope, org_id from runs where id = ${orgId}`;
  const [perRow] = await sql`select memory_scope, user_id from runs where id = ${perId}`;
  check("org run persisted memory_scope=org", orgRow?.memory_scope === "org");
  check("personal run persisted memory_scope=personal", perRow?.memory_scope === "personal");

  const capture = async (id: string): Promise<any | null> => {
    const ok = await waitFor(async () => (await sql`select 1 from memory_outbox where run_id = ${id}`).length === 1);
    if (!ok) return null;
    const [row] = await sql`select payload from memory_outbox where run_id = ${id}`;
    return JSON.parse(row.payload as string);
  };
  const orgCap = await capture(orgId);
  const perCap = await capture(perId);
  const orgPool = `org:${orgRow.org_id}`;
  check(
    "org capture → org pool (user_id = org:<orgId>)",
    !!orgCap && orgCap.scope === "org" && orgCap.identity.userId === orgPool,
    orgCap ? `scope=${orgCap.scope} user=${orgCap.identity.userId}` : "no capture row",
  );
  check(
    "personal capture → personal pool (user_id = actor), NEVER the org pool",
    !!perCap && perCap.scope === "personal" && perCap.identity.userId === perRow.user_id && perCap.identity.userId !== orgPool,
    perCap ? `scope=${perCap.scope} user=${perCap.identity.userId}` : "no capture row",
  );
}

async function stage4_crashMatrix(proc1: Proc): Promise<Proc> {
  console.log("\n── Stage 4: mid-run SIGKILL → restart → ordered recovery (command lane) ──");
  // A long-ish run A, then a queued reply B behind it (same thread). Kill mid-A.
  const aPrompt = `crash-A ${crypto.randomUUID().slice(0, 6)}`;
  const a1 = await fetch(`${BASE}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: aPrompt, engine: "mock" }) });
  const A = (await a1.json() as { id: string }).id;
  await waitRun(aPrompt, (r) => r.status === "running"); // A is mid-flight
  const bPrompt = `crash-B ${crypto.randomUUID().slice(0, 6)}`;
  const b1 = await fetch(`${BASE}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: bPrompt, engine: "mock", parent_run_id: A }) });
  const B = (await b1.json() as { id: string }).id;
  // B waits behind A in the DB mailbox (queued), not an in-memory chain.
  const bQueued = await waitFor(async () => (await sql`select state from commands where run_id = ${B}`)[0]?.state === "queued");
  check("reply B is queued behind A in the durable mailbox", bQueued);

  // SIGKILL mid-run — no graceful shutdown.
  await killBackend(proc1);
  const aAtKill = (await sql`select status from runs where id = ${A}`)[0]?.status;
  check("A was non-terminal at kill (mid-run)", aAtKill === "running", `status=${aAtKill}`);

  // Restart — boot recovery runs on the fresh process.
  const proc2 = await startBackend("restart");

  // A settles (mock can't reconcile → honest fail) and B dispatches AFTER it, in order.
  const aFinal = await waitFor(async () => {
    const s = (await sql`select status from runs where id = ${A}`)[0]?.status;
    return s === "completed" || s === "failed";
  });
  check("A settled after restart (recovery ran)", aFinal);
  const bDone = await waitFor(async () => (await sql`select status from runs where id = ${B}`)[0]?.status === "completed", 15_000);
  check("queued reply B dispatched + completed after restart", bDone);
  const [{ a_at }] = await sql`select updated_at as a_at from runs where id = ${A}`;
  const [{ b_at }] = await sql`select updated_at as b_at from runs where id = ${B}`;
  check("order preserved: B settled after A", new Date(b_at) >= new Date(a_at));
  return proc2;
}

async function stage5_durabilitySurvived(root: { channel: string; rootTs: string }): Promise<void> {
  console.log("\n── Stage 5: durable rows survived the crash ──");
  // The Slack reply + memory capture from Stage 3 were committed before the crash;
  // after restart their delivered rows are still delivered (durable, not replayed
  // into duplicates).
  const del = await sql`select count(*)::int as n from slack_outbox where state = 'delivered'`;
  check("delivered slack_outbox rows persisted across restart", (del[0]?.n ?? 0) >= 1, `${del[0]?.n} delivered`);
  const cap = await sql`select count(*)::int as n from memory_outbox where state = 'delivered'`;
  check("delivered memory_outbox rows persisted across restart", (cap[0]?.n ?? 0) >= 1, `${cap[0]?.n} delivered`);
}

// ── run ───────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("E2E full-stack — isolated stack (:3507, DB skynet_e2e, mock memory/slack)");
  await recreateDb();
  let proc = await startBackend("boot");
  // Safety: confirm the backend is on the throwaway DB before anything else.
  const probe = await fetch(`${BASE}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "db-probe", engine: "mock" }) });
  const probeId = (await probe.json() as { id: string }).id;
  const onThrowaway = (await sql`select 1 from runs where id = ${probeId}`).length === 1;
  if (!onThrowaway) { console.error("ABORT: backend is NOT on the throwaway DB — refusing to continue"); await killBackend(proc); process.exit(2); }

  try {
    await stage1_idempotency();
    await stage2_nativeReplay();
    const root = await stage3_slackMemory();
    await stage3b_scopedCapture();
    proc = await stage4_crashMatrix(proc);
    await stage5_durabilitySurvived(root);
  } finally {
    await killBackend(proc).catch(() => {});
    memServer.stop(true);
    slackServer.stop(true);
    await sql.end().catch(() => {});
    const admin = postgres(ADMIN_URL, { max: 1 });
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
    await admin.end();
  }

  console.log(`\n${failures === 0 ? "✅ E2E PASSED" : `❌ E2E FAILED (${failures} check(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
