/**
 * AGGRESSIVE REAL end-to-end suite — the whole Skynet stability story on a REAL
 * stack: real Daytona sandboxes, real `opencode serve` (claude-haiku-4-5), the
 * REAL team-memory gateway (:8420), the REAL knowledge store. The ONLY mocked
 * leaf is Slack (an in-process receiver — no test workspace). MANUAL-gated (not
 * in `bun test`, spends real Daytona money + real LLM tokens):
 *
 *     bun run e2e:real
 *
 * Requires backend/.env to carry DAYTONA_API_KEY, ANTHROPIC_API_KEY and a
 * reachable MEMORY_API_URL (http://localhost:8420). Bun auto-loads backend/.env,
 * so those ride through to the subprocess backend; this runner OVERRIDES only the
 * isolation knobs (throwaway DB, PORT=3512, mock Slack).
 *
 * Isolation + cost: throwaway DB `skynet_e2e_real`, own backend on :3512, own
 * mock Slack receiver on :3519. NEVER touches :3401/:3501 or the dev DB (a safety
 * probe aborts if the backend is not on the throwaway DB). At most THREE real
 * sandboxes are provisioned (T1 multi-turn+fanout, T3 memory-recall, T4 crash);
 * the teach run (T2) uses the `mock` engine so it costs no sandbox while still
 * exercising the capture outbox → real :8420. Teardown DELETES every test sandbox
 * (by persisted sandbox_id AND by our run-id label) and DROPS the DB.
 *
 * Stages (each asserts; PASS/FAIL/SKIP+reason logged; nonzero exit on any FAIL):
 *   1. Multi-turn thread (Slack→opencode): root → reply, session resumed by id
 *      each turn (same engine_session_id, steps scoped per run), Slack reply
 *      delivered to the mock receiver.
 *   2. Memory round-trip ACROSS THREADS: thread A (mock) teaches a unique canary
 *      → capture outbox delivers to the REAL :8420 → wait for distillation
 *      (bounded, honest timeout) → a NEW thread recalls it in a RESUMED reply,
 *      real opencode answer contains the canary.
 *   3. Reconcile-to-completed FOR REAL: a real opencode run, SIGKILL the backend
 *      mid-run, opencode finishes server-side, restart → run reconciled to
 *      completed with the real answer; a QUEUED reply then dispatches in order.
 *   4. Fanout on the real engine: a turn spawns subagents (child lineage in
 *      provider_events); the native SSE lane survives a mid-stream socket kill +
 *      cursor reconnect with ZERO missing frames.
 *   5. Retrieval ledger: a `ctxret_` frame exists for the recall run with cited
 *      items + the actorUserId scope.
 *   6. Knowledge/KB: org-scoped ingestion + hybrid search returns the seeded doc
 *      (API-level surface that always exists, no sandbox needed).
 *  6b. Agent-callable knowledge: the trusted MCP gateway now EXISTS — a real
 *      opencode run in a real sandbox answers a question it can ONLY answer by
 *      calling knowledge_search through the gateway, proven by a
 *      `knowledge.retrieved` ledger frame + the tool-only fact in the answer.
 *      Needs a publicly-reachable dedicated gateway, so it runs only when the
 *      e2e env carries GATEWAY_PUBLIC_URL (e.g. a tunnel to `bun run gateway`); otherwise it
 *      SKIPs with an honest note — which E2E_STRICT (release mode) turns red.
 */
import { createHmac } from "node:crypto";
import { openSync, readFileSync } from "node:fs";
import { Daytona, type Sandbox } from "@daytona/sdk";
import postgres from "postgres";

// ── configuration ─────────────────────────────────────────────────────────────
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB = "skynet_e2e_real";
const DB_URL = `postgres://postgres@localhost:5432/${DB}`;
const PORT = 3512;
const SLACK_PORT = 3519;
const BASE = `http://localhost:${PORT}`;
const SIGNING = "e2e-real-signing-secret";
const BOT = "U0E2EREAL";
const MODEL = "claude-haiku-4-5";
const SERVE_PORT = 4096; // opencode serve port inside the sandbox
const providerSigningSecret = `provider-real-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const toolSigningSecret = `tool-real-${crypto.randomUUID()}-${crypto.randomUUID()}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backendDir = new URL("../..", import.meta.url).pathname;
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const backendLog = `${scratch}/skynet-e2e-real-backend.log`;

// ── release mode ──────────────────────────────────────────────────────────────
// E2E_STRICT=1 is the RELEASE gate: a SKIP is no longer "fine for dev" — it means
// a capability went unexercised, so it counts as a FAILURE. The default (unset)
// stays permissive so `bun run e2e:real` on a partial env (no cloudflared tunnel,
// no memory gateway) still reports the honest PASS/SKIP mix without red.
const STRICT = process.env.E2E_STRICT === "1";

// ── result tracking ─────────────────────────────────────────────────────────
type Status = "PASS" | "FAIL" | "SKIP";
interface Result { stage: string; name: string; status: Status; detail: string }
const results: Result[] = [];
let currentStage = "";

function stage(name: string): void {
  currentStage = name;
  console.log(`\n══ ${name} ══`);
}
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ stage: currentStage, name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function skip(name: string, reason: string): void {
  // Under E2E_STRICT a skip is a failure — a released build must exercise the
  // whole surface, so an unconfigured dependency is a gap, not an excuse.
  if (STRICT) {
    results.push({ stage: currentStage, name, status: "FAIL", detail: `SKIP under E2E_STRICT: ${reason}` });
    console.log(`  ❌ FAIL ${name} — SKIP under E2E_STRICT (release gate): ${reason}`);
    return;
  }
  results.push({ stage: currentStage, name, status: "SKIP", detail: reason });
  console.log(`  ⏭  SKIP ${name} — ${reason}`);
}
function note(msg: string): void {
  console.log(`  · ${msg}`);
}

// ── provenance stamp ──────────────────────────────────────────────────────────
// Every artifact must be bound to the exact commit + env it was produced under,
// so a green run can never be silently attributed to code it didn't test.
function sh(cmd: string): string {
  try { return Bun.spawnSync(["bash", "-lc", cmd]).stdout.toString().trim(); } catch { return ""; }
}
function provenance(): { sha: string; dirty: boolean; branch: string; ts: string } {
  const sha = sh("git rev-parse --short HEAD") || "unknown";
  const dirty = sh("git status --porcelain") !== "";
  const branch = sh("git rev-parse --abbrev-ref HEAD") || "?";
  return { sha, dirty, branch, ts: new Date().toISOString() };
}
function printProvenance(p: { sha: string; dirty: boolean; branch: string; ts: string }): void {
  console.log(
    `  provenance: commit ${p.sha}${p.dirty ? "+dirty" : ""} (${p.branch}) · ${p.ts} · ` +
      `bun ${Bun.version} · node ${process.version} · ${process.platform}/${process.arch}`,
  );
  const flag = (k: string, v: unknown) => `${k}=${v ? "on" : "off"}`;
  console.log(
    `  env: ${flag("E2E_STRICT", STRICT)} · ${flag("DAYTONA_API_KEY", process.env.DAYTONA_API_KEY)} · ` +
      `${flag("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY)} · ${flag("MEMORY_API_URL", process.env.MEMORY_API_URL)} · ` +
      `${flag("GATEWAY_PUBLIC_URL", process.env.GATEWAY_PUBLIC_URL)} · ${flag("OPENAI_API_KEY", process.env.OPENAI_API_KEY)}`,
  );
}

// ── mock Slack receiver (the ONLY mock) ───────────────────────────────────────
interface SlackHit { method: string; body: any }
const slackHits: SlackHit[] = [];
const slackServer = Bun.serve({
  port: SLACK_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = url.pathname.replace(/^\/api\//, "");
    slackHits.push({ method, body: await req.json().catch(() => ({})) });
    return Response.json({ ok: true, ts: `${Date.now() / 1000}` });
  },
});

// ── backend subprocess control ────────────────────────────────────────────────
type Proc = ReturnType<typeof Bun.spawn>;
async function startBackend(label: string): Promise<Proc> {
  const fd = openSync(backendLog, "a");
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: backendDir,
    env: {
      ...process.env, // carries the REAL DAYTONA/ANTHROPIC/OPENROUTER/MEMORY_* keys
      PORT: String(PORT),
      DATABASE_URL: DB_URL,
      FRONTEND_ORIGIN: "http://localhost:3400",
      // Real memory gateway: DO NOT override MEMORY_API_URL — inherit :8420 from
      // .env. Just make the capture delivery loop fast for the suite.
      MEMORY_OUTBOX_TICK_MS: "2000",
      // Mock Slack: engine opencode + haiku so a Slack-started run is real.
      SLACK_BOT_TOKEN: "xoxb-e2e-real",
      SLACK_SIGNING_SECRET: SIGNING,
      SLACK_API_URL: `http://localhost:${SLACK_PORT}`,
      SLACK_DEFAULT_ENGINE: "opencode",
      SLACK_DEFAULT_MODEL: MODEL,
      SLACK_OUTBOX_TICK_MS: "500",
      SLACK_OUTBOX_BASE_MS: "50",
      // Agent-callable knowledge (Stage 6b): GATEWAY_PUBLIC_URL rides through
      // from the e2e env and must target the dedicated gateway process; give the token a generous TTL so a
      // slow sandbox turn never outlives its auth.
      ...(process.env.GATEWAY_PUBLIC_URL
        ? {
            TOOL_GATEWAY_TOKEN_TTL_MS: process.env.TOOL_GATEWAY_TOKEN_TTL_MS ?? String(30 * 60 * 1000),
            TOOL_GATEWAY_SECRET: toolSigningSecret,
            PROVIDER_GATEWAY_SECRET: providerSigningSecret,
          }
        : {}),
    },
    stdout: fd,
    stderr: fd,
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) {
        console.log(`  [${label}] backend up on :${PORT} (pid ${proc.pid})`);
        return proc;
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`[${label}] backend did not come up (see ${backendLog})`);
}
async function killBackend(proc: Proc): Promise<void> {
  proc.kill(9); // SIGKILL — no graceful shutdown, exactly like a crash
  await proc.exited;
}
function tailBackendLog(lines = 30): void {
  try {
    const all = readFileSync(backendLog, "utf8").trimEnd().split("\n");
    console.log(`  ── backend log tail (${backendLog}) ──`);
    for (const l of all.slice(-lines)) console.log(`  │ ${l}`);
  } catch {
    /* no log */
  }
}

// ── db ────────────────────────────────────────────────────────────────────────
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
async function dropDb(): Promise<void> {
  await sql.end().catch(() => {});
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await admin.end();
}

async function runByLike(marker: string): Promise<any | null> {
  const rows = await sql`select * from runs where prompt like ${"%" + marker + "%"} order by created_at desc limit 1`;
  return rows[0] ?? null;
}
async function waitRun(marker: string, pred: (r: any) => boolean, budgetMs: number): Promise<any> {
  const deadline = Date.now() + budgetMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = await runByLike(marker);
    if (last && pred(last)) return last;
    await sleep(500);
  }
  throw new Error(`waitRun timed out for "${marker}" (last status=${last?.status ?? "none"})`);
}
async function waitFor(fn: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(500);
  }
  return false;
}
async function stepCount(runId: string): Promise<number> {
  const [row] = await sql`select count(*)::int as n from steps where run_id = ${runId}`;
  return row?.n ?? 0;
}

// ── Slack drive ────────────────────────────────────────────────────────────────
function slackHeaders(raw: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = "v0=" + createHmac("sha256", SIGNING).update(`v0:${ts}:${raw}`).digest("hex");
  return { "content-type": "application/json", "x-slack-signature": sig, "x-slack-request-timestamp": ts };
}
async function postSlackEvent(event: Record<string, unknown>): Promise<void> {
  const raw = JSON.stringify({
    type: "event_callback",
    event_id: `Ev${crypto.randomUUID().slice(0, 8)}`,
    authorizations: [{ user_id: BOT }],
    event,
  });
  await fetch(`${BASE}/api/slack/events`, { method: "POST", body: raw, headers: slackHeaders(raw) });
}

// ── native SSE reader (mirrors the frontend cursor contract) ──────────────────
interface NF { eventId: string; seq: number }
async function readNative(url: string, onFrame: (f: NF) => void, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch {
    return;
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let ev = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (ev === "native" && data) {
          const o = JSON.parse(data);
          onFrame({ eventId: o.eventId, seq: o.seq });
          if (signal.aborted) return;
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ── terminal WebSocket round-trip (browser ⇄ backend ⇄ sandbox PTY) ───────────
async function wsTerminalRoundtrip(runId: string, marker: string): Promise<{ connected: boolean; occurrences: number; banner: string }> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://localhost:${PORT}/api/runs/${runId}/terminal?cols=100&rows=30`);
    } catch {
      resolve({ connected: false, occurrences: 0, banner: "ws construct failed" });
      return;
    }
    let connected = false;
    let buf = "";
    const finish = (): void => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      const occ = (buf.match(new RegExp(marker, "g")) ?? []).length;
      const banner = /\[skynet\][^\n]*/.exec(buf)?.[0] ?? "";
      resolve({ connected, occurrences: occ, banner });
    };
    const timer = setTimeout(finish, 60_000);
    ws.onmessage = (e) => {
      buf += typeof e.data === "string" ? e.data : "";
      if (!connected && buf.includes("connected to sandbox")) {
        connected = true;
        try { ws.send(JSON.stringify({ type: "input", data: `echo ${marker}\n` })); } catch { /* gone */ }
      }
      // Marker appears twice on success: the tty-echoed input line + the command
      // output. ≥2 ⇒ the command round-tripped AND executed in the sandbox.
      if (connected && (buf.match(new RegExp(marker, "g")) ?? []).length >= 2) finish();
    };
    ws.onerror = () => { if (!connected) finish(); };
    ws.onclose = () => { /* finish() already scheduled/called */ };
  });
}

// ── Daytona direct access (crash-stage server-side probe + cleanup) ───────────
function daytonaClient(): Daytona {
  return new Daytona({ apiKey: process.env.DAYTONA_API_KEY!, target: process.env.DAYTONA_TARGET ?? "us" });
}
/** Resolve a started sandbox's resident opencode endpoint (mirrors
 *  opencode-server.openResidentServer). Null if unconfigured/stopped/gone. */
async function residentServer(
  sandboxId: string,
): Promise<{ baseUrl: string; token: string; dirQ: string } | null> {
  try {
    const d = daytonaClient();
    const sb = await d.get(sandboxId).catch(() => null);
    if (!sb || (sb as { state?: string }).state !== "started") return null;
    const home =
      (await sb.process.executeCommand('printf %s "$HOME"', undefined, undefined, 6).catch(() => null))
        ?.result?.trim() || "/root";
    const link = await sb.getPreviewLink(SERVE_PORT);
    return { baseUrl: link.url.replace(/\/+$/, ""), token: link.token ?? "", dirQ: `?directory=${encodeURIComponent(`${home}/work`)}` };
  } catch {
    return null;
  }
}
/** True once the session's last assistant message is completed server-side. */
async function opencodeSessionCompleted(sandboxId: string, sessionId: string): Promise<boolean> {
  const s = await residentServer(sandboxId);
  if (!s) return false;
  const res = await fetch(`${s.baseUrl}/session/${sessionId}/message${s.dirQ}`, {
    headers: { "x-daytona-preview-token": s.token },
  }).catch(() => null);
  if (!res || !res.ok) return false;
  const msgs = (await res.json().catch(() => [])) as { info?: { role?: string; time?: { completed?: number } } }[];
  const assistants = msgs.filter((m) => m.info?.role === "assistant");
  const last = assistants[assistants.length - 1];
  return typeof last?.info?.time?.completed === "number";
}

// ── real team-memory search (direct :8420 probe for distillation readiness) ───
function memIdentity() {
  return {
    url: (process.env.MEMORY_API_URL ?? "").replace(/\/+$/, ""),
    apiKey: process.env.MEMORY_API_KEY ?? "",
    serviceId: process.env.MEMORY_SERVICE_ID ?? "skynet",
    teamId: process.env.MEMORY_TEAM_ID ?? "skynet",
    agentId: process.env.MEMORY_AGENT_ID ?? "skynet-backend",
    userId: process.env.MEMORY_USER_ID ?? "skynet",
  };
}
async function searchMemoryDirect(query: string): Promise<{ id: string; content: string }[]> {
  const cfg = memIdentity();
  if (!cfg.url) return [];
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(`${cfg.url}/v3/atomic/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "x-tdai-service-id": cfg.serviceId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ team_id: cfg.teamId, agent_id: cfg.agentId, user_id: cfg.userId, query, limit: 8 }),
      signal: ctl.signal,
    });
    if (!res.ok) return [];
    const env = (await res.json()) as { code?: number; data?: { items?: { id: string; content: string }[] } };
    if (typeof env.code === "number" && env.code !== 0) return [];
    return env.data?.items ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

// ── API helpers ────────────────────────────────────────────────────────────────
async function createRun(body: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${BASE}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json() as { id: string }).id;
}

// ══════════════════════════════════════════════════════════════════════════════
// STAGES
// ══════════════════════════════════════════════════════════════════════════════

// Stage 6 — knowledge ingestion + hybrid search (no sandbox; run first, fast win).
async function stage6_knowledge(): Promise<void> {
  stage("Stage 6: Knowledge/KB — org-scoped ingest + hybrid search (API-level)");
  const token = `kbcanary${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const text =
    `Skynet E2E knowledge canary ${token}. Deployment runbook: to roll back the ${token} release, ` +
    `run the command 'skynet rollback --to ${token}'. This unique test document verifies org-scoped ` +
    `knowledge ingestion and hybrid retrieval end to end.`;
  const ingestRes = await fetch(`${BASE}/api/knowledge/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      meta: {
        source_type: "document",
        external_id: token,
        connector_instance_id: "e2e-real:web",
        source_url: "https://example.com/e2e-real",
        domain: "e2e",
      },
      text,
    }),
  });
  const ingest = (await ingestRes.json()) as { id?: string; status?: string; stub?: boolean };
  check("ingest accepted (stored/skipped)", ingestRes.ok && (ingest.status === "stored" || ingest.status === "skipped"), `status=${ingest.status} stub=${ingest.stub} http=${ingestRes.status}`);
  if (!ingest.id) {
    skip("hybrid search returns the seeded doc", `ingest returned no id (status=${ingest.status})`);
    return;
  }
  note(`ingested id=${ingest.id} (distill ${ingest.stub ? "stub — no OPENROUTER distill / dev fallback" : "ran"})`);

  // Search — the seeded doc must be retrievable by its own id.
  let found = false;
  let mode = "?";
  await waitFor(async () => {
    const sres = await fetch(`${BASE}/api/knowledge/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `${token} deployment runbook rollback`, k: 8 }),
    });
    if (!sres.ok) return false;
    const j = (await sres.json()) as { results?: { id: string }[]; mode?: string };
    mode = j.mode ?? "?";
    found = (j.results ?? []).some((r) => r.id === ingest.id);
    return found;
  }, 15_000);
  check("hybrid search returns the seeded doc (by id)", found, `mode=${mode} (keyword-only ⇒ no OPENAI_API_KEY; still org-scoped retrieval)`);
  note("this stage covers the ingest+search API surface only; Stage 6b proves the SAME KB is agent-callable mid-run through the trusted gateway.");
}

// Stage 6b — agent-callable knowledge over the trusted MCP gateway. A REAL
// opencode run in a REAL sandbox reaches the dedicated gateway over GATEWAY_PUBLIC_URL
// (a cloudflared tunnel to the gateway process in a release run) and answers a question it can ONLY
// answer by calling knowledge_search. Reuses the machinery proven in
// test/manual/knowledge-gateway-live.ts. Gated on GATEWAY_PUBLIC_URL being
// present in the e2e env (so the sandbox can reach us); when unset it SKIPs with
// an honest note — E2E_STRICT (release mode) turns that skip red.
async function stage6b_knowledgeGateway(): Promise<void> {
  stage("Stage 6b: Knowledge is agent-callable — real opencode run calls knowledge_search via the gateway");
  const publicUrl = process.env.GATEWAY_PUBLIC_URL;
  if (!publicUrl) {
    skip(
      "agent CALLS knowledge_search through the gateway (ledger frame + tool-only answer)",
      "GATEWAY_PUBLIC_URL unset — start `bun run gateway`, tunnel that narrow port, and export it (see test/manual/knowledge-gateway-live.ts)",
    );
    return;
  }
  note(`gateway reachable at ${publicUrl} (sandbox → backend); TTL=${process.env.TOOL_GATEWAY_TOKEN_TTL_MS ?? "default"}`);

  // Seed a UNIQUE fact only the tool can reveal.
  const code = `RB-${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  const label = "nimbus";
  const ingestRes = await fetch(`${BASE}/api/knowledge/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      meta: { source_type: "document", external_id: `e2e-gw-${code}`, connector_instance_id: "e2e-real:gateway", source_url: "https://example.com/e2e-gw" },
      text:
        `Deployment rollback codes. The rollback authorization code for the ${label} service is ${code}. ` +
        `To roll back ${label}, run 'skynet rollback ${label} --code ${code}'. This value lives only in the knowledge base.`,
    }),
  });
  const ingest = (await ingestRes.json()) as { status?: string };
  check("unique fact ingested into the org KB", ingestRes.ok && (ingest.status === "stored" || ingest.status === "skipped"), `status=${ingest.status} code=${code}`);

  // Real opencode run that MUST use the tool to answer.
  const marker = `askgw-${crypto.randomUUID().slice(0, 6)}`;
  const prompt =
    `${marker} You do NOT know the rollback authorization code for the ${label} service — it is stored only in the ` +
    `organization knowledge base. Call the knowledge_search tool (query for the ${label} rollback authorization code), ` +
    `then reply with ONLY the code, nothing else.`;
  const runId = await createRun({ prompt, engine: "opencode", model: MODEL });
  note(`run ${runId} created; waiting for the real sandbox turn (up to 6 min)…`);

  const deadline = Date.now() + 6 * 60 * 1000;
  let row: any = null;
  while (Date.now() < deadline) {
    [row] = await sql`select id, status, summary from runs where id = ${runId}`;
    if (row && (row.status === "completed" || row.status === "failed")) break;
    await sleep(3000);
  }
  check("run reached a terminal state", row?.status === "completed" || row?.status === "failed", `status=${row?.status}`);

  // THE proof: a knowledge.retrieved ledger frame means the sandbox agent actually
  // CALLED the gateway (server-side), and the answer contains the tool-only code.
  const ledger = await sql`select payload from provider_events where run_id = ${runId} and event_type = 'knowledge.retrieved'`;
  check("agent CALLED the gateway (knowledge.retrieved ledger frame exists)", ledger.length > 0, `${ledger.length} frame(s)`);
  if (ledger.length > 0) {
    const p = JSON.parse(ledger[0]!.payload as string);
    note(`ledger: tool=${p.tool} query="${String(p.query).slice(0, 60)}" items=${p.itemCount} org=${p.scope?.orgId}`);
  }
  const answer = String(row?.summary ?? "");
  check("the run's answer contains the tool-only code", answer.includes(code), `code=${code} answer="${answer.slice(0, 80)}"`);
}

// Stage 2a — teach a canary through a real run so the capture outbox delivers it
// to the REAL :8420 gateway. Uses the `mock` engine (canary rides in the user
// turn) so the teach costs no sandbox; the capture→:8420 delivery is genuine.
async function stage2a_teach(): Promise<{ token: string; phrase: string; runId: string } | null> {
  stage("Stage 2a: Memory teach — capture outbox delivers a canary to REAL :8420");
  const cfg = memIdentity();
  if (!cfg.url) {
    skip("capture delivered to :8420", "MEMORY_API_URL unset — memory layer disabled");
    return null;
  }
  const token = `e2ereal-${crypto.randomUUID().slice(0, 8)}`;
  const phrase = `${token}-VERIFIED`;
  const teachPrompt = `Please record this team fact exactly and confirm: the ${token} verification phrase is "${phrase}".`;
  const runId = await createRun({ prompt: teachPrompt, engine: "mock", model: MODEL });
  const run = await waitRun(token, (r) => r.status === "completed", 60_000).catch(() => null);
  check("teach run completed (capture enqueued at finalization)", !!run && run.status === "completed", run ? `run ${run.id.slice(0, 8)}` : "did not complete");
  if (!run) return null;

  const delivered = await waitFor(async () => {
    const [row] = await sql`select state from memory_outbox where run_id = ${run.id}`;
    return row?.state === "delivered";
  }, 30_000);
  const [capRow] = await sql`select state, attempt_count, last_error from memory_outbox where run_id = ${run.id}`;
  check("memory_outbox row DELIVERED to the real gateway", delivered, `state=${capRow?.state} attempts=${capRow?.attempt_count}${capRow?.last_error ? ` err=${capRow.last_error}` : ""}`);
  if (!delivered) return null;
  note(`taught canary "${token}" (phrase "${phrase}") into the shared team pool (user_id=${cfg.userId}) — distillation is async server-side`);
  return { token, phrase, runId: run.id };
}

// Stage 1 (+ Slack reply) + Stage 4 (fanout + SSE kill) on ONE real sandbox.
async function stage1_and_4(): Promise<void> {
  stage("Stage 1: Multi-turn thread (Slack → real opencode) — resume by session id");
  const channel = `C${crypto.randomUUID().slice(0, 6)}`;
  const rootTs = `${Date.now() / 1000}`.slice(0, 14);
  const m1 = `s1root-${crypto.randomUUID().slice(0, 6)}`;
  const m2 = `s1reply-${crypto.randomUUID().slice(0, 6)}`;
  const mFan = `s4fan-${crypto.randomUUID().slice(0, 6)}`;

  // Turn 1 — root app_mention → a fresh opencode session.
  await postSlackEvent({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> ${m1} Reply with a one-sentence greeting and nothing else.`, ts: rootTs });
  const run1 = await waitRun(m1, (r) => r.status === "completed" || r.status === "failed", 300_000);
  check("turn 1 (root) completed on the real engine", run1.status === "completed", `status=${run1.status} engine=${run1.engine}`);
  check("turn 1 recorded an opencode session id", !!run1.engine_session_id, `session=${run1.engine_session_id ?? "none"}`);
  check("turn 1 recorded a sandbox id", !!run1.sandbox_id, `sandbox=${run1.sandbox_id?.slice(0, 8) ?? "none"}`);
  check("turn 1 produced steps", (await stepCount(run1.id)) > 0, `${await stepCount(run1.id)} steps`);
  const gotReply1 = slackHits.some((h) => h.method === "chat.postMessage" && h.body.channel === channel && h.body.thread_ts === rootTs);
  check("turn 1 Slack reply delivered to the mock receiver", gotReply1);

  if (run1.status !== "completed") {
    skip("turn 2 resume assertions", "turn 1 did not complete — see backend log");
    return;
  }

  // Turn 2 — threaded reply → the SAME session, resumed by id.
  await postSlackEvent({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> ${m2} Reply with a one-sentence farewell and nothing else.`, ts: `${rootTs}.2`, thread_ts: rootTs });
  const run2 = await waitRun(m2, (r) => r.status === "completed" || r.status === "failed", 300_000);
  check("turn 2 (reply) completed", run2.status === "completed", `status=${run2.status}`);
  check("turn 2 is a follow-up in the same thread", run2.parent_run_id === run1.id && run2.thread_id === run1.thread_id, `parent=${run2.parent_run_id?.slice(0, 8)} thread=${run2.thread_id?.slice(0, 8)}`);
  check("turn 2 RESUMED the same engine session id", !!run2.engine_session_id && run2.engine_session_id === run1.engine_session_id, `t1=${run1.engine_session_id} t2=${run2.engine_session_id}`);
  const s1 = await stepCount(run1.id);
  const s2 = await stepCount(run2.id);
  check("steps scoped per turn (each run owns its own steps)", s1 > 0 && s2 > 0, `turn1=${s1} steps, turn2=${s2} steps (FK-partitioned by run_id)`);
  const gotReply2 = slackHits.some((h) => h.method === "chat.postMessage" && h.body.thread_ts === rootTs && h.body.text?.includes((run2.summary ?? "").trim().slice(0, 24)) && (run2.summary ?? "").length > 0);
  check("turn 2 Slack reply delivered (matches run summary)", gotReply2 || run2.status !== "completed");

  // ── Stage 4 — fanout turn on the SAME sandbox + SSE kill/reconnect ──────────
  stage("Stage 4: Fanout on the real engine — child lineage + SSE kill/reconnect (zero missing)");
  const fanPrompt =
    `${mFan} Use your task tool to spawn THREE subagents IN PARALLEL, one per capital: ` +
    `(1) the capital of France, (2) the capital of Japan, (3) the capital of Brazil. ` +
    `Each subagent returns just its city name. Then list the three answers.`;
  await postSlackEvent({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> ${fanPrompt}`, ts: `${rootTs}.3`, thread_ts: rootTs });

  // Wait until the fanout run row exists + is running.
  const run3 = await waitRun(mFan, (r) => !!r.id, 60_000);
  note(`fanout run ${run3.id.slice(0, 8)} accepted; opening the native SSE lane`);

  // First connection: read native frames, then kill the socket mid-stream.
  const store = new Map<string, number>();
  let cursor = -1;
  const ac1 = new AbortController();
  const killTimer = setTimeout(() => ac1.abort(), 40_000); // safety cap
  await readNative(`${BASE}/api/runs/${run3.id}/events?cursor=-1`, (f) => {
    store.set(f.eventId, Math.max(store.get(f.eventId) ?? -1, f.seq));
    cursor = Math.max(cursor, f.seq);
    if (store.size >= 5) ac1.abort(); // kill after a partial burst
  }, ac1.signal);
  clearTimeout(killTimer);
  const afterKill = store.size;
  check("native SSE lane streamed frames then was killed mid-stream", afterKill >= 1, `${afterKill} frames before kill`);

  // Reconnect from cursor and drain until the run completes.
  let laterOnly = true;
  const runDone = () => waitFor(async () => {
    const r = await runByLike(mFan);
    return r?.status === "completed" || r?.status === "failed";
  }, 1);
  const drainDeadline = Date.now() + 300_000;
  while (Date.now() < drainDeadline) {
    const ac2 = new AbortController();
    const t = setTimeout(() => ac2.abort(), 8_000);
    await readNative(`${BASE}/api/runs/${run3.id}/events?cursor=${cursor}`, (f) => {
      if (f.seq <= cursor) laterOnly = false;
      store.set(f.eventId, Math.max(store.get(f.eventId) ?? -1, f.seq));
      cursor = Math.max(cursor, f.seq);
    }, ac2.signal);
    clearTimeout(t);
    if (await runDone()) break;
    await sleep(500);
  }
  const fanFinal = await runByLike(mFan);
  check("fanout turn reached a terminal state", fanFinal?.status === "completed" || fanFinal?.status === "failed", `status=${fanFinal?.status}`);
  check("reconnect replayed ONLY strictly-later frames (cursor honored)", laterOnly);

  // Compare the reassembled store against the authoritative provider_events rows.
  const dbRows = await sql`select id, seq from provider_events where run_id = ${run3.id}`;
  const missing = dbRows.filter((r) => store.get(r.id as string) !== (r.seq as number));
  check("ZERO missing native frames after kill+reconnect (store == provider_events)", dbRows.length > 0 && missing.length === 0, `db=${dbRows.length} frames, missing=${missing.length}`);

  // Child lineage — subagent sessions recorded with a parent linkage.
  const [lin] = await sql`select count(*)::int as n from provider_events where run_id = ${run3.id} and native_parent_session_id is not null`;
  const children = lin?.n ?? 0;
  check("child lineage recorded in provider_events (parent linkage present)", children >= 1, `${children} child-session lifecycle rows`);
  if (children < 3) note(`fanout produced ${children} tracked child session(s) (<3) — model fan-out is nondeterministic; the lineage + zero-missing invariants are the hard asserts`);
}

// Stage 3 — mid-run SIGKILL → server-side completion → reconcile → ordered reply.
async function stage3_crashReconcile(proc: Proc): Promise<Proc> {
  stage("Stage 3: Reconcile-to-completed FOR REAL — SIGKILL mid-run, restart, ordered queued reply");
  const mA = `s3A-${crypto.randomUUID().slice(0, 6)}`;
  const mB = `s3B-${crypto.randomUUID().slice(0, 6)}`;
  // SHORT turn so opencode finishes it server-side quickly (reconcile-to-completed
  // needs A done server-side before the restart probe). One file + read-back.
  const aPrompt = `${mA} Write a short haiku about the ocean to ocean.txt, then read it back.`;
  const A = await createRun({ prompt: aPrompt, engine: "opencode", model: MODEL });

  // A must be genuinely mid-run AND the prompt must have REACHED opencode (else a
  // kill before the prompt landed leaves nothing to reconcile). Gate on a real
  // opencode provider_event — that proves the turn is streaming server-side.
  let a: any = null;
  const midOk = await waitFor(async () => {
    a = await runByLike(mA);
    if (!(a?.status === "running" && a.engine_session_id && a.sandbox_id)) return false;
    const [pe] = await sql`select count(*)::int as n from provider_events where run_id = ${a.id} and provider = 'opencode'`;
    return (pe?.n ?? 0) >= 1;
  }, 300_000);
  check("run A reached mid-flight (running + session + sandbox + opencode streaming)", midOk, a ? `status=${a.status} session=${!!a.engine_session_id} sandbox=${!!a.sandbox_id}` : "no row");
  if (!midOk || !a) {
    skip("reconcile-to-completed + ordered reply", "run A never reached a killable mid-run state");
    return proc;
  }

  // Queue reply B behind A (durable mailbox, not an in-memory chain).
  await createRun({ prompt: `${mB} Now also create d.txt with a one-line haiku about mountains.`, engine: "opencode", model: MODEL, parent_run_id: A });
  const bQueued = await waitFor(async () => {
    const b = await runByLike(mB);
    if (!b) return false;
    const [cmd] = await sql`select state from commands where run_id = ${b.id}`;
    return cmd?.state === "queued";
  }, 30_000);
  check("reply B is QUEUED behind A in the durable mailbox", bQueued);
  const bRow = await runByLike(mB);

  // SIGKILL — no graceful shutdown.
  const sandboxId = a.sandbox_id as string;
  const sessionId = a.engine_session_id as string;
  await killBackend(proc);
  const [aAtKill] = await sql`select status from runs where id = ${a.id}`;
  check("A was non-terminal (running) at the SIGKILL", aAtKill?.status === "running", `status=${aAtKill?.status}`);

  // Let opencode finish A server-side (probe the resident server directly). 300s
  // window so a real turn has room to complete before the reconcile probe runs.
  note("waiting for opencode to finish run A server-side (backend is dead)…");
  const finishedServerSide = await waitFor(() => opencodeSessionCompleted(sandboxId, sessionId), 300_000);
  note(finishedServerSide ? "opencode completed A server-side" : "opencode did NOT complete A within 300s (server-side)");

  // Restart — boot recovery runs on the fresh process.
  const proc2 = await startBackend("restart");

  const [aFinal] = await waitFor(async () => {
    const [r] = await sql`select status, summary from runs where id = ${a.id}`;
    return r?.status === "completed" || r?.status === "failed";
  }, 30_000)
    ? await sql`select status, summary from runs where id = ${a.id}`
    : [{ status: "unsettled", summary: null }];
  if (finishedServerSide) {
    const reconciled = aFinal?.status === "completed" && !!aFinal.summary && !String(aFinal.summary).startsWith("Interrupted");
    check("A RECONCILED to completed with the real answer after restart", reconciled, `status=${aFinal?.status} summary="${String(aFinal?.summary ?? "").slice(0, 60)}"`);
  } else {
    skip("A reconciled to completed", "opencode did not finish A server-side within the 300s wait window (timing characteristic, not a lane defect); boot correctly fails-safe to STALE. Ordering still asserted below.");
    check("A settled to a terminal state after restart (fail-safe)", aFinal?.status === "completed" || aFinal?.status === "failed", `status=${aFinal?.status}`);
  }

  // B dispatches AFTER A and completes — durable ordering across the crash.
  const bDone = await waitFor(async () => {
    const [r] = await sql`select status from runs where id = ${bRow.id}`;
    return r?.status === "completed" || r?.status === "failed";
  }, 300_000);
  const [bFinal] = await sql`select status, updated_at from runs where id = ${bRow.id}`;
  check("queued reply B dispatched + settled after restart", bDone && bFinal?.status === "completed", `status=${bFinal?.status}`);
  const [aUpd] = await sql`select updated_at from runs where id = ${a.id}`;
  if (aUpd?.updated_at && bFinal?.updated_at) {
    check("order preserved: B settled at/after A", new Date(bFinal.updated_at) >= new Date(aUpd.updated_at), `A=${aUpd.updated_at} B=${bFinal.updated_at}`);
  }
  return proc2;
}

// Stage 2b (+ Stage 5) — cross-thread recall in a resumed reply + the ledger.
async function stage2b_recall(teach: { token: string; phrase: string } | null): Promise<void> {
  stage("Stage 2 (recall) + Stage 5: cross-thread recall in a resumed reply + retrieval ledger");
  if (!teach) {
    skip("cross-thread canary recall", "no canary was taught (stage 2a skipped/failed)");
    skip("retrieval ledger frame for the recall run", "no recall run");
    return;
  }
  const { token, phrase } = teach;

  // Wait (bounded) for the gateway to distill the canary into a searchable fact.
  note(`polling REAL :8420 for distillation of "${token}" (bounded 120s)…`);
  const distilled = await waitFor(async () => (await searchMemoryDirect(`${token} verification phrase`)).some((i) => i.content.includes(token)), 120_000);
  if (!distilled) {
    skip("cross-thread canary recall in a resumed reply", "gateway did not distill the canary within 120s (Tencent Team Memory async L0→L1 is non-deterministic, esp. cold — a memory-service characteristic, not a Skynet defect)");
    skip("retrieval ledger frame for the recall run", "recall did not run (distillation timeout)");
    return;
  }
  note("canary is distilled + searchable in the shared pool");

  // NEW thread (different thread_id than the teach) — root then a RESUMED reply.
  const mRoot = `s2root-${crypto.randomUUID().slice(0, 6)}`;
  const mAsk = `s2ask-${crypto.randomUUID().slice(0, 6)}`;
  const rootId = await createRun({ prompt: `${mRoot} Reply with just the word ready.`, engine: "opencode", model: MODEL });
  const root = await waitRun(mRoot, (r) => r.status === "completed" || r.status === "failed", 300_000);
  check("recall thread root run completed (fresh session established)", root.status === "completed", `status=${root.status}`);
  if (root.status !== "completed") {
    skip("cross-thread canary recall in a resumed reply", "recall-thread root run failed");
    skip("retrieval ledger frame for the recall run", "recall did not run");
    return;
  }

  const askPrompt = `${mAsk} What is the ${token} verification phrase? Reply with ONLY the phrase, verbatim.`;
  await createRun({ prompt: askPrompt, engine: "opencode", model: MODEL, parent_run_id: rootId });
  const ask = await waitRun(mAsk, (r) => r.status === "completed" || r.status === "failed", 300_000);
  check("recall reply completed (RESUMED session)", ask.status === "completed" && ask.engine_session_id === root.engine_session_id, `status=${ask.status} resumed=${ask.engine_session_id === root.engine_session_id}`);
  check("cross-thread recall: the real answer contains the canary phrase", typeof ask.summary === "string" && (ask.summary.includes(phrase) || ask.summary.includes(token)), `answer="${String(ask.summary ?? "").slice(0, 80)}"`);

  // ── Stage 5 — retrieval ledger frame for the recall reply ──────────────────
  const ledgerOk = await waitFor(async () => {
    const [row] = await sql`select 1 from provider_events where id = ${"ctxret_" + ask.id}`;
    return !!row;
  }, 15_000);
  const [ledger] = await sql`select payload from provider_events where id = ${"ctxret_" + ask.id}`;
  let payloadOk = false;
  let detail = "no frame";
  if (ledger?.payload) {
    try {
      const p = JSON.parse(ledger.payload as string);
      payloadOk = p.itemCount > 0 && Array.isArray(p.items) && p.items.length > 0 && p.items[0]?.citation && typeof p.scope?.actorUserId === "string";
      detail = `items=${p.itemCount} actorUserId=${p.scope?.actorUserId} citationProvider=${p.items?.[0]?.citation?.provider}`;
    } catch {
      detail = "unparseable payload";
    }
  }
  check("retrieval ledger `ctxret_` frame recorded for the recall run", ledgerOk, `id=ctxret_${ask.id.slice(0, 8)}`);
  check("ledger frame carries cited items + actorUserId scope", payloadOk, detail);
}

// Stage 7 — API guardrails / invalid-input error paths (cheap, no sandbox).
async function stage7_apiGuardrails(): Promise<void> {
  stage("Stage 7: API guardrails — invalid-input error paths (400/404)");
  const post = (body: Record<string, unknown>) =>
    fetch(`${BASE}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const noPrompt = await post({ engine: "mock" });
  check("missing prompt → 400", noPrompt.status === 400, `got ${noPrompt.status}`);

  const badEngine = await post({ prompt: "x", engine: "totally-not-an-engine" });
  const badEngineBody = (await badEngine.json().catch(() => ({}))) as { error?: string };
  check("unknown engine → 400 (validated at the API boundary)", badEngine.status === 400, `got ${badEngine.status}: ${badEngineBody.error ?? ""}`);

  const badParent = await post({ prompt: "x", engine: "mock", parent_run_id: crypto.randomUUID() });
  check("unknown parent_run_id → 404", badParent.status === 404, `got ${badParent.status}`);

  // Invalid MODEL is NOT rejected at the API (model is a free string, defaulted).
  // Document the contract honestly: it is accepted (201) and surfaces as an
  // engine-time FAILURE instead — the real invalid-model error path is proven in
  // Stage 9 on the live engine (a bogus-model turn fails cleanly, no false success).
  const badModel = await post({ prompt: "x", engine: "mock", model: "not-a-real-model-xyz" });
  check("invalid model is ACCEPTED at the API (no 400) — contract note", badModel.status === 201, `got ${badModel.status} (model is unvalidated by design; engine-time failure is the guard — see Stage 9)`);
  note("FINDING: POST /api/runs does not validate `model` — an invalid model is accepted and only fails once the engine rejects it (a whole sandbox turn is spent). Flagging as a product observation, not fixed here (no src touched).");
}

// Stage 8 — N=2 concurrent threads run in parallel (durable lane cross-thread
// concurrency). Mock engine — the concurrency invariant is engine-agnostic and
// this keeps it sandbox-free.
async function stage8_concurrency(): Promise<void> {
  stage("Stage 8: N=2 concurrent-thread interleave (durable lane, mock)");
  const mX = `s8X-${crypto.randomUUID().slice(0, 6)}`;
  const mY = `s8Y-${crypto.randomUUID().slice(0, 6)}`;
  // Two DIFFERENT threads (no parent) → the mailbox dispatches both immediately.
  const [x, y] = await Promise.all([
    createRun({ prompt: `${mX} concurrency probe X`, engine: "mock", model: MODEL }),
    createRun({ prompt: `${mY} concurrency probe Y`, engine: "mock", model: MODEL }),
  ]);
  // Observe a moment where BOTH are running at once (cross-thread concurrency).
  const bothRunning = await waitFor(async () => {
    const rows = await sql`select id, status, thread_id from runs where id in (${x}, ${y})`;
    return rows.length === 2 && rows.every((r) => r.status === "running") && rows[0].thread_id !== rows[1].thread_id;
  }, 20_000);
  check("two runs on different threads are RUNNING concurrently", bothRunning);
  const doneBoth = await waitFor(async () => {
    const rows = await sql`select status from runs where id in (${x}, ${y})`;
    return rows.length === 2 && rows.every((r) => r.status === "completed");
  }, 60_000);
  check("both concurrent runs completed", doneBoth);
}

// Stage 9 — terminal WS round-trip + desktop proxy 200, sharing ONE real
// sandbox; plus the invalid-model engine-time failure on that same sandbox.
async function stage9_terminalDesktop(): Promise<void> {
  stage("Stage 9: terminal WS + desktop proxy (one shared sandbox) + invalid-model engine failure");
  if (!process.env.DAYTONA_API_KEY) {
    skip("terminal + desktop", "DAYTONA_API_KEY unset");
    return;
  }
  const mRoot = `s9root-${crypto.randomUUID().slice(0, 6)}`;
  const rootId = await createRun({ prompt: `${mRoot} Reply with just the word ready.`, engine: "opencode", model: MODEL });
  const root = await waitRun(mRoot, (r) => r.status === "completed" || r.status === "failed", 300_000);
  check("stage-9 opencode run completed (sandbox live)", root.status === "completed", `status=${root.status} sandbox=${root.sandbox_id?.slice(0, 8)}`);
  if (root.status !== "completed" || !root.sandbox_id) {
    skip("terminal WS round-trip", "no live sandbox");
    skip("desktop proxy serves noVNC (200)", "no live sandbox");
    skip("invalid-model turn fails cleanly", "no live sandbox");
    return;
  }

  // (c) Terminal WS round-trip — attach a PTY, echo a unique marker, read it back.
  const termMarker = `SKTERM${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const term = await wsTerminalRoundtrip(rootId, termMarker);
  check("terminal WS attached to the sandbox PTY", term.connected, term.banner || "no banner");
  check("terminal WS round-trip: echoed marker returned from the sandbox", term.occurrences >= 1, `marker seen ${term.occurrences}× (≥2 ⇒ tty-echo + executed output)`);

  // (d) Desktop proxy — noVNC static app served through the same-origin bridge.
  const vnc = await fetch(`${BASE}/api/desktop-proxy/${rootId}/vnc.html`);
  const vncType = vnc.headers.get("content-type") ?? "";
  check("desktop proxy serves noVNC over the sandbox (200)", vnc.status === 200, `status=${vnc.status} content-type=${vncType}`);
  if (vnc.status !== 200) note("noVNC :6080 may not be running on this snapshot build — reporting the real status, not faking a pass");

  // (a-live) Invalid-model engine-time failure — a bogus model on the real engine
  // fails the turn cleanly (no hang, no false success), reusing this sandbox.
  const mBad = `s9bad-${crypto.randomUUID().slice(0, 6)}`;
  await createRun({ prompt: `${mBad} say hi`, engine: "opencode", model: "totally-invalid-model-zzz", parent_run_id: rootId });
  const bad = await waitRun(mBad, (r) => r.status === "completed" || r.status === "failed", 180_000);
  check("invalid-model turn FAILED cleanly with an error summary (engine-time guard)", bad.status === "failed" && typeof bad.summary === "string" && /error|opencode|model|HTTP/i.test(bad.summary), `status=${bad.status} summary="${String(bad.summary ?? "").slice(0, 80)}"`);
}

// ── cleanup ─────────────────────────────────────────────────────────────────
async function cleanupSandboxes(): Promise<void> {
  if (!process.env.DAYTONA_API_KEY) return;
  console.log("\n── cleanup: deleting test sandboxes ──");
  const runIds = new Set((await sql`select id from runs`.catch(() => [])).map((r) => r.id as string));
  const ids = new Set(
    (await sql`select distinct sandbox_id from runs where sandbox_id is not null`.catch(() => [])).map((r) => r.sandbox_id as string),
  );
  const d = daytonaClient();
  // Belt-and-suspenders: also sweep by our run-id label (a sandbox created but
  // whose sandbox_id never persisted, e.g. a crash before setRunSandbox). ONLY
  // delete sandboxes whose skynet-run label is one of OUR throwaway run ids —
  // never another agent's box.
  try {
    for await (const sb of d.list()) {
      const label = (sb as { labels?: Record<string, string> }).labels?.["skynet-run"];
      if (label && runIds.has(label)) ids.add(sb.id);
    }
  } catch {
    /* list is best-effort */
  }
  let deleted = 0;
  for (const id of ids) {
    try {
      const sb = await d.get(id);
      await sb.delete();
      deleted++;
      console.log(`  🗑  deleted sandbox ${id.slice(0, 12)}`);
    } catch (e) {
      console.log(`  ⚠️  could not delete sandbox ${id.slice(0, 12)}: ${(e as Error).message}`);
    }
  }
  console.log(`  cleanup: ${deleted}/${ids.size} test sandbox(es) deleted`);
}

// ══════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log("AGGRESSIVE REAL E2E — real Daytona + opencode(claude-haiku-4-5) + real :8420 memory + mock Slack only");
  console.log(`  DB=${DB} PORT=${PORT} slack-mock=:${SLACK_PORT} backend-log=${backendLog}`);
  const prov = provenance();
  printProvenance(prov);
  if (STRICT) console.log("  MODE: E2E_STRICT — every SKIP counts as a FAILURE (release gate).");

  // Preflight.
  if (!process.env.DAYTONA_API_KEY) {
    console.error("ABORT: DAYTONA_API_KEY is not set — the real suite needs real sandboxes.");
    process.exit(2);
  }
  const memUp = await fetch((process.env.MEMORY_API_URL ?? "http://localhost:8420"), { method: "GET" }).then(() => true).catch(() => false);
  note(`preflight: DAYTONA_API_KEY present; ANTHROPIC_API_KEY ${process.env.ANTHROPIC_API_KEY ? "present" : "MISSING"}; memory gateway ${memUp ? "reachable" : "UNREACHABLE"}`);

  await recreateDb();
  let proc = await startBackend("boot");

  // Safety: confirm the backend is on the throwaway DB before ANY real work.
  const probeId = await createRun({ prompt: "db-probe", engine: "mock", model: MODEL });
  const onThrowaway = (await sql`select 1 from runs where id = ${probeId}`).length === 1;
  if (!onThrowaway) {
    console.error("ABORT: backend is NOT on the throwaway DB — refusing to continue");
    await killBackend(proc);
    await slackServer.stop(true);
    process.exit(2);
  }

  const startedAt = Date.now();
  try {
    await runStage(stage6_knowledge);
    await runStage(stage6b_knowledgeGateway);
    await runStage(stage7_apiGuardrails);
    const teach = await stage2a_teachSafe();
    await runStage(stage8_concurrency);
    await runStage(stage1_and_4);
    await runStage(stage9_terminalDesktop);
    proc = await stage3Safe(proc);
    await runStage(() => stage2b_recall(teach));
  } finally {
    await killBackend(proc).catch(() => {});
    await cleanupSandboxes().catch((e) => console.log(`  cleanup error: ${(e as Error).message}`));
    await slackServer.stop(true);
    await dropDb();
  }

  // ── summary ────────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n══ SUMMARY (${Math.round((Date.now() - startedAt) / 1000)}s) — ${pass} PASS / ${fail} FAIL / ${skipped} SKIP ══`);
  printProvenance(prov);
  for (const r of results) {
    const icon = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : "⏭ ";
    console.log(`  ${icon} [${r.stage.split(":")[0]}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log("\n  NOTE: test canary facts are written to the shared team-memory pool; the gateway has no delete API, so they are NOT cleaned (honest).");
  if (fail > 0) tailBackendLog(40);
  console.log(`\n${fail === 0 ? "✅ REAL E2E PASSED" : `❌ REAL E2E FAILED (${fail} check(s))`}`);
  process.exit(fail === 0 ? 0 : 1);
}

/** Wrap a stage so an unexpected throw is recorded as a FAIL (and never aborts
 *  the remaining stages) — an aggressive suite runs every stage. */
async function runStage(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    check(`stage threw (${currentStage.split(":")[0] || "?"})`, false, (e as Error).message);
  }
}
async function stage2a_teachSafe(): Promise<{ token: string; phrase: string; runId: string } | null> {
  try {
    return await stage2a_teach();
  } catch (e) {
    check("stage 2a threw", false, (e as Error).message);
    return null;
  }
}
async function stage3Safe(proc: Proc): Promise<Proc> {
  try {
    return await stage3_crashReconcile(proc);
  } catch (e) {
    check("stage 3 threw", false, (e as Error).message);
    // Ensure a live backend for the remaining stages.
    try {
      await fetch(`${BASE}/api/health`);
      return proc;
    } catch {
      return await startBackend("restart-after-throw");
    }
  }
}

await main();
