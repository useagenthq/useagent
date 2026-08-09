/**
 * Thread-stream browser proof (final_fix.md §5.3 / DoD §11) — a focused real-Chrome
 * E2E for the thread-scoped realtime cutover. Boots a FULLY ISOLATED stack, drives
 * the exact multi-turn frustration scenarios in a real browser, and tears down.
 *
 * Manual-gated (NOT part of `bun test` — it boots servers + Chrome). Run from the
 * backend dir:
 *
 *   bun run test/e2e/thread-stream-proof.ts
 *
 * Isolation + safety (never the shared `skynet` DB or the shared :3401/:3501 servers):
 *   - PREFLIGHT: both ports must be FREE before any DB mutation or spawn; if either
 *     is occupied the run aborts WITHOUT killing anything (it never assumes the PID
 *     is ours - Codex E2E hardening).
 *   - per-run UNIQUE throwaway DB `skynet_thread_e2e_<hex>`, dropped only after the
 *     admin host is validated local (or an explicit remote opt-in is set).
 *   - backend on :3577 (mock engine, WORKER_STEP_DELAY_MS=1000 so turns are slow
 *     enough to reply mid-stream), SLACK/MEMORY/DAYTONA/OPENROUTER stripped.
 *   - frontend `next dev` on :3477 retargeted via SKYNET_API_ORIGIN.
 *   - safety gate: aborts unless the freshly-migrated backend DB is empty.
 *   - TEARDOWN kills ONLY the Bun.spawn children (graceful SIGTERM then SIGKILL),
 *     never a blanket lsof-kill of whatever holds the port.
 *
 * Engine note (honesty, per the DoD): this drives the DETERMINISTIC MOCK engine
 * (the sanctioned §5.3 alternative to a slow OpenCode turn). It exercises the exact
 * thread-stream / thread-store / useThreadStream / SessionView path end-to-end
 * through a real browser + real backend SSE; the engine only differs in what step
 * frames it emits. It is NOT real-OpenCode proof and is not reported as such. A
 * repeatable REAL-engine variant is a separate manual script.
 */
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import postgres from "postgres";
import { chromium, type Browser, type Page } from "playwright-core";
import type { ApiRun } from "../../src/runs/repo";

const BE_PORT = Number(process.env.TS_BE_PORT ?? 3577);
const FE_PORT = Number(process.env.TS_FE_PORT ?? 3477);
const BE = `http://localhost:${BE_PORT}`;
const FE = `http://localhost:${FE_PORT}`;
const ORIGIN = "http://localhost:3200";
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
// Per-run unique db so concurrent runs never collide and a DROP can only ever hit
// this run's own database.
const DB = `skynet_thread_e2e_${crypto.randomUUID().slice(0, 8).replace(/-/g, "")}`;
const SHOTS = process.env.TS_SHOTS ?? "/tmp/thread-e2e-shots/";
const backendRoot = join(import.meta.dir, "..", "..");
const frontendRoot = join(backendRoot, "..", "frontend");

const results: { name: string; ok: boolean; note?: string }[] = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push({ name, ok, note });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? ` - ${note}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True if something is already listening on the port (we must NOT touch it). */
function portOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    sock.setTimeout(800, () => { sock.destroy(); resolve(false); });
  });
}

/** Validate the admin target is local (or an explicit remote opt-in) before any DROP. */
function assertSafeAdmin(): void {
  let host = "";
  try { host = new URL(ADMIN_URL).hostname; } catch { host = ""; }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (!local && process.env.TS_ALLOW_REMOTE_ADMIN !== "1") {
    throw new Error(`refusing to DROP DATABASE on non-local admin host "${host}" - set TS_ALLOW_REMOTE_ADMIN=1 to override`);
  }
  if (!/^skynet_thread_e2e_[0-9a-f]{8}$/.test(DB)) {
    throw new Error(`refusing to DROP unexpected database name "${DB}"`);
  }
}

async function createDb(): Promise<void> {
  assertSafeAdmin();
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`); // name is validated above
    await admin.unsafe(`CREATE DATABASE ${DB}`);
    console.log(`[thread-stream-proof] created ${DB} on ${new URL(ADMIN_URL).hostname}`);
  } finally {
    await admin.end();
  }
}
async function dropDb(): Promise<void> {
  try { assertSafeAdmin(); } catch { return; }
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
    console.log(`[thread-stream-proof] dropped ${DB}`);
  } finally {
    await admin.end();
  }
}

async function waitHttp(url: string, opts: { budgetMs?: number; predicate?: (status: number, body: string) => boolean } = {}): Promise<void> {
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { headers: { Origin: ORIGIN } });
      const body = await r.text();
      if (opts.predicate ? opts.predicate(r.status, body) : r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error(`waitHttp timed out for ${url}`);
}

async function mkRun(prompt: string, parent?: string): Promise<string> {
  const r = await fetch(`${BE}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ prompt, engine: "mock", model: "claude-haiku-4-5", ...(parent ? { parent_run_id: parent } : {}) }),
  });
  return ((await r.json()) as { id: string }).id;
}
async function getRun(id: string): Promise<ApiRun | null> {
  const r = await fetch(`${BE}/api/runs/${id}`, { headers: { Origin: ORIGIN } });
  return r.ok ? ((await r.json()) as ApiRun) : null;
}
async function getThread(rootId: string): Promise<ApiRun[]> {
  const r = await fetch(`${BE}/api/runs/${rootId}?thread=1`, { headers: { Origin: ORIGIN } });
  return r.ok ? (((await r.json()) as { thread?: ApiRun[] }).thread ?? []) : [];
}

const MOCK_ROW_MARKERS = ["Cloning repository", "Analyzing codebase", "Editing file", "Running Command"];
const markersPresent = (t: string) => MOCK_ROW_MARKERS.filter((m) => t.includes(m));
const mainText = (page: Page) => page.locator("main").innerText().catch(() => "");
const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

interface Net { thread: string[]; perRun: string[] }
function trackNet(page: Page): Net {
  const net: Net = { thread: [], perRun: [] };
  page.on("request", (req) => {
    const u = req.url();
    if (/\/api\/runs\/[^/]+\/thread-events/.test(u)) net.thread.push(u);
    else if (/\/api\/runs\/[^/]+\/events(\?|$)/.test(u)) net.perRun.push(u);
  });
  return net;
}
async function submitReply(page: Page, text: string): Promise<void> {
  let ta = page.locator('textarea[aria-label^="Reply to Skynet"]');
  if ((await ta.count()) === 0) ta = page.locator("main textarea").first();
  await ta.waitFor({ state: "visible", timeout: 15_000 });
  await ta.click();
  await ta.fill(text);
  await page.keyboard.press("Enter");
}
const waitRows = (page: Page, n: number, budgetMs = 30_000) =>
  page.waitForFunction(
    ({ markers, n }) => {
      const t = (document.querySelector("main") as HTMLElement)?.innerText ?? "";
      return markers.filter((m) => t.includes(m)).length >= n;
    },
    { markers: MOCK_ROW_MARKERS, n },
    { timeout: budgetMs },
  );

async function scenarioMultiTurn(browser: Browser): Promise<void> {
  console.log("\n[A] reply mid-stream: prior tools never vanish, ONE connection, no run-switch");
  const aPrompt = "thread-e2e ROOT turn A";
  const A = await mkRun(aPrompt);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const net = trackNet(page);
  await page.goto(`${FE}/session/${A}`, { waitUntil: "domcontentloaded" });
  await waitRows(page, 2);
  const before = markersPresent(await mainText(page));
  check("A: streaming with >=2 tool rows before reply", before.length >= 2, `rows=${before.length}`);
  await page.screenshot({ path: `${SHOTS}A1-before-reply.png` }).catch(() => {});

  const bPrompt = "thread-e2e REPLY B mid-stream";
  await submitReply(page, bPrompt);
  let everVanished = false, bSeen = false;
  for (let i = 0; i < 7; i++) {
    await sleep(500);
    const t = await mainText(page);
    // A is still running here (B just queued), so A stays flat - its rows must not
    // drop. (Once A SETTLES they fold into "Ran N tools" by design; that is a later
    // state, after this running-window poll.)
    if (markersPresent(t).length < before.length) everVanished = true;
    if (t.includes(bPrompt)) bSeen = true;
  }
  check("A: prior tool rows never vanished while A ran (no flash)", !everVanished);
  check("B: queued reply bubble appeared (no blank assistant block)", bSeen);
  check("ONE thread EventSource; ZERO per-run /events (no run-switch)", net.thread.length === 1 && net.perRun.length === 0, `thread=${net.thread.length} perRun=${net.perRun.length}`);
  await page.screenshot({ path: `${SHOTS}A2-after-reply.png` }).catch(() => {});

  // Wait for B to START its own work burst. A timeout FAILS the scenario (no swallow):
  // the mock re-emits "Cloning repository", so a 2nd occurrence proves B's turn ran.
  await page.waitForFunction(
    (bp) => {
      const t = (document.querySelector("main") as HTMLElement)?.innerText ?? "";
      return t.includes(bp) && (t.split("Cloning repository").length - 1) >= 2;
    },
    bPrompt,
    { timeout: 60_000 },
  );
  const afterB = await mainText(page);
  check("B: started + streaming on the SAME connection (no new thread-events)", net.thread.length === 1, `thread=${net.thread.length}`);
  // Run-scoped (not label-based): both turns' USER bubbles are distinct texts, so
  // their presence proves A is preserved AND B rendered - independent of the shared
  // mock tool labels that B also emits.
  check("both turns render: A's prompt + B's prompt both present", afterB.includes(aPrompt) && afterB.includes(bPrompt));
  check("A preserved: its work still shown (rows, or 'Ran N tools' after settle-fold)", afterB.includes("Ran ") || markersPresent(afterB).length >= 2);
  await page.screenshot({ path: `${SHOTS}A3-B-running.png` }).catch(() => {});

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const reloadText = await mainText(page);
  check("reload: exactly ONE new thread connection (per-run events still 0)", net.thread.length === 2 && net.perRun.length === 0, `thread=${net.thread.length} perRun=${net.perRun.length}`);
  check("reload: reply B bubble present exactly once (no duplicate)", occurrences(reloadText, bPrompt) === 1, `count=${occurrences(reloadText, bPrompt)}`);
  check("reload: A's prompt still present (durable projection restored)", reloadText.includes(aPrompt));
  await page.screenshot({ path: `${SHOTS}A4-after-reload.png` }).catch(() => {});
  await page.close();
}

async function scenarioStop(browser: Browser): Promise<void> {
  console.log("\n[B] Stop targets the RUNNING run, not the newest queued reply");
  const C = await mkRun("thread-e2e STOP root C");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${FE}/session/${C}`, { waitUntil: "domcontentloaded" });
  await waitRows(page, 1);
  await submitReply(page, "thread-e2e STOP reply D queued");
  await sleep(1500);
  const thread1 = await getThread(C);
  const D = thread1.find((r) => r.id !== C)?.id;
  check("Stop: reply D queued behind running C", !!D && thread1.length === 2, `runs=${thread1.length}`);
  // Stop now lives in the composer send button (running+empty -> Stop); the top-bar
  // Stop was removed. Target that composer Stop.
  await page.getByRole("button", { name: /^Stop/ }).first().click().catch(() => {});
  await sleep(2500);
  const cAfter = await getRun(C);
  const dAfter = D ? await getRun(D) : null;
  check("Stop: RUNNING run C was cancelled (Stopped by user)", cAfter?.status === "failed" && (cAfter?.summary ?? "").includes("Stopped by user"), `C=${cAfter?.status}`);
  check("Stop: queued reply D was NOT the cancel target", (dAfter?.summary ?? "") !== "Stopped by user", `D=${dAfter?.status}`);
  await page.screenshot({ path: `${SHOTS}B-stop.png` }).catch(() => {});
  await page.close();
}

async function scenarioSendNow(browser: Browser): Promise<void> {
  console.log("\n[C] Send-now affordance on the head queued turn (FIFO promotion)");
  const E = await mkRun("thread-e2e SENDNOW root E");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${FE}/session/${E}`, { waitUntil: "domcontentloaded" });
  await waitRows(page, 1);
  await submitReply(page, "thread-e2e SENDNOW reply F");
  await sleep(1500);
  const sendNow = page.getByRole("button", { name: /Send now/i });
  const present = (await sendNow.count()) > 0;
  check("Send-now: affordance shown on head queued turn while a run is live", present);
  if (present) {
    const thread = await getThread(E);
    const F = thread.find((r) => r.id !== E)?.id;
    await sendNow.first().click().catch(() => {});
    await sleep(2500);
    const eAfter = await getRun(E);
    const fAfter = F ? await getRun(F) : null;
    check("Send-now: running E cancelled -> head queued F promoted (FIFO)", eAfter?.status === "failed" && fAfter?.status !== "queued", `E=${eAfter?.status} F=${fAfter?.status}`);
  }
  await page.screenshot({ path: `${SHOTS}C-sendnow.png` }).catch(() => {});
  await page.close();
}

async function scenarioExternal(browser: Browser): Promise<void> {
  console.log("\n[D] external turn appears WITHOUT reload or the 5s poll");
  const G = await mkRun("thread-e2e EXTERNAL root G");
  for (let i = 0; i < 40; i++) { const r = await getRun(G); if (r?.status === "completed" || r?.status === "failed") break; await sleep(500); }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const net = trackNet(page);
  await page.goto(`${FE}/session/${G}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const before = await mainText(page);
  const extPrompt = "thread-e2e EXTERNAL injected turn (Slack-like)";
  await mkRun(extPrompt, G); // central acceptance, no browser action
  let appeared = false;
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) { await sleep(400); if ((await mainText(page)).includes(extPrompt)) { appeared = true; break; } }
  check("external turn appeared without reload", appeared, `after ${Date.now() - t0}ms`);
  check("external turn arrived on the SAME connection (no reconnect)", net.thread.length === 1 && net.perRun.length === 0, `thread=${net.thread.length} perRun=${net.perRun.length}`);
  check("external turn was not present before injection (real delivery)", !before.includes(extPrompt));
  await page.screenshot({ path: `${SHOTS}D-external.png` }).catch(() => {});
  await page.close();
}

// ── Orchestration ────────────────────────────────────────────────────────────
const childEnv = (extra: Record<string, string>): Record<string, string> => {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  for (const k of ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "MEMORY_API_URL", "GATEWAY_PUBLIC_URL", "TOOL_GATEWAY_PUBLIC_URL", "DAYTONA_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "GITHUB_PAT", "GH_TOKEN"]) delete base[k];
  return { ...base, ...extra };
};

let backend: ReturnType<typeof Bun.spawn> | null = null;
let frontend: ReturnType<typeof Bun.spawn> | null = null;

/** Terminate ONE owned child: SIGTERM, wait a bounded grace, then SIGKILL. */
async function killChild(child: ReturnType<typeof Bun.spawn> | null): Promise<void> {
  if (!child) return;
  try { child.kill(); } catch { /* already gone */ }
  const exited = await Promise.race([child.exited.then(() => true), sleep(2500).then(() => false)]);
  if (!exited) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
}
async function teardown(): Promise<void> {
  // Only ever touch OUR spawned children - never a blanket kill of whatever holds
  // the port (the preflight already proved the ports were free at start).
  await Promise.all([killChild(backend), killChild(frontend)]);
  await dropDb().catch(() => {});
}

async function main(): Promise<void> {
  await Bun.$`mkdir -p ${SHOTS}`.quiet().catch(() => {});

  // PREFLIGHT: refuse to run (and never kill) if either port is already in use.
  for (const [name, port] of [["backend", BE_PORT], ["frontend", FE_PORT]] as const) {
    if (await portOccupied(port)) {
      throw new Error(`ABORT: ${name} port ${port} is already in use - refusing to run (not killing it). Set TS_BE_PORT/TS_FE_PORT to free ports.`);
    }
  }

  console.log(`[thread-stream-proof] creating throwaway DB ${DB}`);
  await createDb();

  console.log(`[thread-stream-proof] booting backend :${BE_PORT} (mock, slow steps)`);
  backend = Bun.spawn(["bun", "run", "src/index.ts"], {
    cwd: backendRoot,
    env: childEnv({
      DATABASE_URL: `postgres://postgres@localhost:5432/${DB}`,
      PORT: String(BE_PORT),
      WORKER_STEP_DELAY_MS: "1000",
      ALLOW_DEV_ORG: "1",
      NODE_ENV: "development",
    }),
    stdout: Bun.file("/tmp/thread-e2e-backend.log"),
    stderr: Bun.file("/tmp/thread-e2e-backend.log"),
  });
  await waitHttp(`${BE}/api/health`);
  const seed = (await (await fetch(`${BE}/api/runs?all=1`, { headers: { Origin: ORIGIN } })).json()) as { runs?: ApiRun[] };
  if ((seed.runs ?? []).length !== 0) throw new Error("ABORT: backend DB is not empty - refusing to run against a populated DB");

  console.log(`[thread-stream-proof] booting frontend :${FE_PORT} (next dev -> :${BE_PORT})`);
  frontend = Bun.spawn(["bunx", "next", "dev", "-p", String(FE_PORT)], {
    cwd: frontendRoot,
    env: childEnv({ SKYNET_API_ORIGIN: BE, PORT: String(FE_PORT) }),
    stdout: Bun.file("/tmp/thread-e2e-frontend.log"),
    stderr: Bun.file("/tmp/thread-e2e-frontend.log"),
  });
  await waitHttp(`${FE}/api/runs`, { budgetMs: 90_000, predicate: (s, b) => s === 200 && b.includes("runs") });

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    await scenarioMultiTurn(browser);
    await scenarioStop(browser);
    await scenarioSendNow(browser);
    await scenarioExternal(browser);
  } finally {
    await browser.close();
  }
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error("\n[thread-stream-proof] FATAL:", err instanceof Error ? err.message : err);
  exitCode = 1;
} finally {
  await teardown();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n===== thread-stream browser proof: ${results.length - failed.length}/${results.length} checks passed =====`);
if (failed.length) console.log("FAILED:", failed.map((f) => f.name).join(" | "));
console.log(`Screenshots: ${SHOTS}`);
console.log("Engine: MOCK (deterministic, per final_fix.md §5.3). NOT real-OpenCode proof.");
process.exit(exitCode || (failed.length ? 1 : 0));
