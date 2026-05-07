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
 * Isolation (never the shared `skynet` DB or the shared :3401/:3501 servers):
 *   - throwaway DB `skynet_thread_e2e` (dropped + recreated each run)
 *   - backend on :3577 (mock engine, WORKER_STEP_DELAY_MS=1000 so turns are slow
 *     enough to reply mid-stream), SLACK/MEMORY/DAYTONA/OPENROUTER stripped
 *   - frontend `next dev` on :3477 retargeted via SKYNET_API_ORIGIN
 *   - safety gate: aborts unless the freshly-migrated backend DB is empty
 *
 * Engine note (honesty, per the DoD): this drives the DETERMINISTIC MOCK engine
 * (the sanctioned §5.3 alternative to a slow OpenCode turn). It exercises the exact
 * thread-stream / thread-store / useThreadStream / SessionView path end-to-end
 * through a real browser + real backend SSE; the engine only differs in what step
 * frames it emits. It is NOT real-OpenCode proof and is not reported as such.
 */
import { join } from "node:path";
import postgres from "postgres";
import { chromium, type Browser, type Page } from "playwright-core";

const BE_PORT = Number(process.env.TS_BE_PORT ?? 3577);
const FE_PORT = Number(process.env.TS_FE_PORT ?? 3477);
const BE = `http://localhost:${BE_PORT}`;
const FE = `http://localhost:${FE_PORT}`;
const ORIGIN = "http://localhost:3200";
const DB = "skynet_thread_e2e";
const SHOTS = process.env.TS_SHOTS ?? "/tmp/thread-e2e-shots/";
const backendRoot = join(import.meta.dir, "..", "..");
const frontendRoot = join(backendRoot, "..", "frontend");

const results: { name: string; ok: boolean; note?: string }[] = [];
const check = (name: string, ok: boolean, note?: string) => {
  results.push({ name, ok, note });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? ` - ${note}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function recreateDb(): Promise<void> {
  const admin = postgres(process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres", { max: 1 });
  try {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
}
async function dropDb(): Promise<void> {
  const admin = postgres(process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres", { max: 1 });
  try {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
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
  return (await r.json()).id as string;
}
async function getRun(id: string): Promise<any> {
  const r = await fetch(`${BE}/api/runs/${id}`, { headers: { Origin: ORIGIN } });
  return r.ok ? r.json() : null;
}
async function getThread(rootId: string): Promise<any[]> {
  const r = await fetch(`${BE}/api/runs/${rootId}?thread=1`, { headers: { Origin: ORIGIN } });
  return r.ok ? (await r.json()).thread ?? [] : [];
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
  const A = await mkRun("thread-e2e ROOT turn A");
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
    if (markersPresent(t).length < before.length) everVanished = true;
    if (t.includes(bPrompt)) bSeen = true;
  }
  check("A: prior tool rows never vanished during/after reply (no flash)", !everVanished);
  check("B: queued reply bubble appeared (no blank assistant block)", bSeen);
  check("ONE thread EventSource; ZERO per-run /events (no run-switch)", net.thread.length === 1 && net.perRun.length === 0, `thread=${net.thread.length} perRun=${net.perRun.length}`);
  await page.screenshot({ path: `${SHOTS}A2-after-reply.png` }).catch(() => {});

  await page.waitForFunction(() => {
    const t = (document.querySelector("main") as HTMLElement)?.innerText ?? "";
    return (t.split("Cloning repository").length - 1) >= 2;
  }, undefined, { timeout: 45_000 }).catch(() => {});
  check("B: started + streaming on the SAME connection (no new thread-events)", net.thread.length === 1, `thread=${net.thread.length}`);
  await page.screenshot({ path: `${SHOTS}A3-B-running.png` }).catch(() => {});

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const reloadText = await mainText(page);
  check("reload: exactly ONE new thread connection (per-run events still 0)", net.thread.length === 2 && net.perRun.length === 0, `thread=${net.thread.length} perRun=${net.perRun.length}`);
  check("reload: reply B bubble present exactly once (no duplicate)", occurrences(reloadText, bPrompt) === 1, `count=${occurrences(reloadText, bPrompt)}`);
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
  // Strip anything that would touch shared infra or the network (mock-only proof).
  for (const k of ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "MEMORY_API_URL", "TOOL_GATEWAY_PUBLIC_URL", "DAYTONA_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "GITHUB_PAT", "GH_TOKEN"]) delete base[k];
  return { ...base, ...extra };
};

let backend: ReturnType<typeof Bun.spawn> | null = null;
let frontend: ReturnType<typeof Bun.spawn> | null = null;
async function teardown(): Promise<void> {
  try { backend?.kill(); } catch { /* ignore */ }
  try { frontend?.kill(); } catch { /* ignore */ }
  await sleep(500);
  await Bun.$`bash -lc ${`lsof -ti :${BE_PORT} :${FE_PORT} | xargs kill -9 2>/dev/null || true`}`.quiet().catch(() => {});
  await dropDb().catch(() => {});
}

async function main(): Promise<void> {
  await Bun.$`mkdir -p ${SHOTS}`.quiet().catch(() => {});
  console.log(`[thread-stream-proof] recreating throwaway DB ${DB}`);
  await recreateDb();

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
  // Safety gate: the freshly-migrated DB MUST be empty (else we're on a populated DB).
  const seed = await (await fetch(`${BE}/api/runs?all=1`, { headers: { Origin: ORIGIN } })).json();
  if ((seed.runs ?? []).length !== 0) throw new Error("ABORT: backend DB is not empty — refusing to run against a populated DB");

  console.log(`[thread-stream-proof] booting frontend :${FE_PORT} (next dev -> :${BE_PORT})`);
  frontend = Bun.spawn(["bunx", "next", "dev", "-p", String(FE_PORT)], {
    cwd: frontendRoot,
    env: childEnv({ SKYNET_API_ORIGIN: BE, PORT: String(FE_PORT) }),
    stdout: Bun.file("/tmp/thread-e2e-frontend.log"),
    stderr: Bun.file("/tmp/thread-e2e-frontend.log"),
  });
  // Wait until the dev proxy serves the dev-org runs list (compiles on first hit).
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
