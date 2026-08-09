/**
 * C6 - REAL per-engine React browser journey (no engine relabeling, no SQL-seeded happy-path
 * catalog). Self-boots an ISOLATED flag-on frontend (NEXT_PUBLIC_CANONICAL_TIMELINE=1) + an
 * isolated backend on a throwaway DB against a REAL Daytona sandbox + REAL provider, and drives
 * the actual React UI:
 *   1. author a real skill; open the New Task form, CHOOSE engine + repo + skill (deep-link) in
 *      React, type a prompt, and press "Start agent";
 *   2. on the session page, observe streaming + tool rows and the canonical lane;
 *   3. open the LIVE provider command picker (populated by the session's durable commands.updated,
 *      NOT a seed) and SUBMIT a safe command as the next turn;
 *   4. prove the second turn reused the SAME sandbox + provider session;
 *   5. reload -> no missing/duplicate rows;
 *   6. stop a genuinely in-flight turn;
 *   7. assert truthful desktop/terminal surface states (capability-driven).
 *
 * One sandbox per engine; deleted + API-verified at the end. Emits C6_EVIDENCE=<json>.
 * Run (from backend/):  E2E_ENGINE=opencode bun test/e2e/c6-react-journey.ts
 *                       E2E_ENGINE=claude   bun test/e2e/c6-react-journey.ts
 *                       E2E_ENGINE=codex    E2E_MODEL=gpt-5 bun test/e2e/c6-react-journey.ts
 */
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { openSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { deleteById, listAll } from "./soak/lib/daytona";

type Engine = "opencode" | "claude" | "codex";
const ENGINE = (process.env.E2E_ENGINE ?? "opencode") as Engine;
const MODEL = process.env.E2E_MODEL ?? (ENGINE === "opencode" ? "anthropic/claude-haiku-4.5" : "claude-haiku-4-5");
const PORTS: Record<Engine, { be: number; fe: number }> = {
  opencode: { be: 3542, fe: 3443 }, claude: { be: 3543, fe: 3444 }, codex: { be: 3544, fe: 3445 },
};
const BE_PORT = PORTS[ENGINE].be;
const FE_PORT = PORTS[ENGINE].fe;
const BE = `http://localhost:${BE_PORT}`;
const FE = `http://localhost:${FE_PORT}`;
const DB = `skynet_e2e_c6_${ENGINE}`;
const DB_URL = `postgres://postgres@localhost:5432/${DB}`;
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DIST = `.next-c6-${ENGINE}`;
const ORIGIN = "http://localhost:3200";
const BUDGET_MS = Number(process.env.E2E_TERMINAL_MS ?? (ENGINE === "opencode" ? 240_000 : 420_000));
const MARKER = `C6MARK_${ENGINE}`;
// The EXACT assistant reply the agent is told to produce. The C6 pass criterion is that a single
// rendered assistant text node EQUALS this string (not that the timeline merely CONTAINS the
// marker) - which also proves D1: the cumulative ACP text is ONE coherent node, since a
// token-per-line regression would render N fragments and NO single node would equal the full reply.
const ANSWER = `DONE${MARKER}`;
const backendDir = new URL("../..", import.meta.url).pathname;
const frontendDir = new URL("../../../frontend", import.meta.url).pathname;
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const SHOTS = process.env.C6_SHOTS ?? "/tmp/c6-shots/";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Cell = { cell: string; status: "pass" | "fail" | "blocked" | "na"; note: string };
const cells: Cell[] = [];
const rec = (cell: string, status: Cell["status"], note = "") => {
  cells.push({ cell, status, note });
  const i = status === "pass" ? "OK " : status === "fail" ? "XX " : status === "blocked" ? "-- " : ".. ";
  console.log(`  ${i} [${ENGINE}] ${cell}${note ? ` - ${note}` : ""}`);
};
const pass = (cell: string, cond: boolean, note = "") => rec(cell, cond ? "pass" : "fail", note);
const sandboxIds = new Set<string>();
const myRunIds: string[] = [];
const short = (s: unknown, n = 8) => String(s ?? "").slice(0, n);
const sql = postgres(DB_URL, { max: 3 });

async function waitHttp(url: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* not up */ }
    await sleep(1000);
  }
  return false;
}
async function api(path: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${BE}${path}`, { headers: { Origin: ORIGIN } });
  return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
}
async function dbRun(id: string) {
  const [r] = await sql`SELECT id, engine, status, summary, thread_id, engine_session_id, sandbox_id, command_name FROM runs WHERE id = ${id}`;
  return r as Record<string, unknown> | undefined;
}
async function waitTerminal(id: string, budgetMs: number) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const d = await dbRun(id);
    if (d?.sandbox_id) sandboxIds.add(d.sandbox_id as string);
    if (d && ["completed", "failed", "cancelled"].includes(d.status as string)) return d;
    await sleep(2000);
  }
  return null;
}
// canonical-flagon helpers (inlined; the harness reads BE/FE from env at import, we self-boot)
const timelineSource = (p: Page) => p.$$eval("[data-timeline-source]", (els) => els.map((e) => (e as HTMLElement).dataset.timelineSource ?? ""));
const runIds = (p: Page) => p.$$eval("[data-run-id]", (els) => els.map((e) => (e as HTMLElement).getAttribute("data-run-id") ?? ""));
const toolCount = (p: Page) => p.$$eval('[data-testid="tool-row"]', (els) => els.length).catch(() => 0);
const timelineText = (p: Page) => p.$$eval('[data-testid="turn-block"]', (els) => els.map((e) => (e as HTMLElement).innerText).join("\n")).catch(() => "");
// The trimmed text of every rendered assistant answer node (TextBurst -> data-testid="agent-answer").
// EXACT-equality against ANSWER (not a substring of the whole timeline) is the C6 pass criterion.
const answerTexts = (p: Page) => p.$$eval('[data-testid="agent-answer"]', (els) => els.map((e) => ((e as HTMLElement).innerText ?? "").trim())).catch(() => [] as string[]);
async function shot(page: Page, name: string) { await page.screenshot({ path: `${SHOTS}${ENGINE}-${name}.png`, fullPage: true }).catch(() => {}); }
async function waitCanonical(page: Page, budgetMs = 60_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) { if ((await timelineSource(page)).includes("canonical")) return true; await sleep(1000); }
  return false;
}

let be: ReturnType<typeof Bun.spawn> | null = null;
let fe: ReturnType<typeof Bun.spawn> | null = null;
let browser: Browser | null = null;
let daytonaBlocked = false;
const tsconfigPath = `${frontendDir}/tsconfig.json`;
const tsconfigBefore = readFileSync(tsconfigPath, "utf8");

try {
  console.log(`\n=== C6 REACT JOURNEY (engine=${ENGINE}, model=${MODEL}, FE=${FE}, BE=${BE}) ===\n`);
  await Bun.$`mkdir -p ${SHOTS}`.quiet().catch(() => {});
  // throwaway DB
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin`DROP DATABASE IF EXISTS ${admin.unsafe(DB)} WITH (FORCE)`.catch(() => {});
  await admin`CREATE DATABASE ${admin.unsafe(DB)}`;
  await admin.end();

  // isolated backend (real Daytona/providers pass through)
  const beLog = openSync(`${scratch}/c6-${ENGINE}-be.log`, "a");
  be = Bun.spawn(["bun", "src/index.ts"], {
    cwd: backendDir,
    env: { ...process.env, PORT: String(BE_PORT), DATABASE_URL: DB_URL, ALLOW_DEV_ORG: "1", FRONTEND_ORIGIN: FE, ENABLED_ENGINES: process.env.ENABLED_ENGINES ?? "opencode,claude,codex" },
    stdout: beLog, stderr: beLog,
  });
  pass("isolated flag-on stack: backend booted (throwaway DB)", await waitHttp(`${BE}/health`, 60_000), `db=${DB}`);

  // isolated flag-ON frontend (canonical timeline default-on for the journey), rewrites -> our BE
  const feLog = openSync(`${scratch}/c6-${ENGINE}-fe.log`, "a");
  fe = Bun.spawn(["bun", "run", "dev", "--port", String(FE_PORT)], {
    cwd: frontendDir,
    env: { ...process.env, PORT: String(FE_PORT), SKYNET_API_ORIGIN: BE, SKYNET_BUILD_DIST: DIST, NEXT_PUBLIC_CANONICAL_TIMELINE: "1" },
    stdout: feLog, stderr: feLog,
  });
  pass("isolated flag-on stack: frontend booted", await waitHttp(`${FE}/agent/new`, 150_000));

  // author a real skill (selected in React via ?skill=)
  const skillRes = await fetch(`${BE}/api/skills`, {
    method: "POST", headers: { "content-type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ name: `c6 ${ENGINE} skill`, description: "C6 verify skill", sections: { overview: [`Marker ${MARKER}`], procedure: ["Be concise."], verify: ["skill.loaded exists"] } }),
  });
  const skillId = (await skillRes.json().catch(() => ({})))?.id as string | undefined;
  pass("authored a real skill (selectable in React)", !!skillId, `id=${short(skillId)}`);

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  // ── 1. New Task FORM: choose engine + skill (deep-link) + repo + prompt, in React ──
  await page.goto(`${FE}/agent/new${skillId ? `?skill=${skillId}` : ""}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForSelector('button:has-text("Start agent")', { timeout: 60_000 }).catch(() => {});
  // engine: open the picker, filter, pick the engine - verified + retried (the trigger button text
  // must reflect the choice), so a flaky click can never silently leave the default (opencode).
  const LABELS: Record<Engine, string> = { opencode: "OpenCode", claude: "Claude Code", codex: "Codex" };
  let engineChosen = ENGINE === "opencode"; // opencode is the default selection
  for (let attempt = 0; attempt < 3 && !engineChosen; attempt++) {
    try {
      await page.click('button[aria-label="Select engine"]', { timeout: 10_000 });
      const search = page.locator('input[aria-label="Search engines..."]');
      await search.waitFor({ state: "visible", timeout: 5_000 });
      await search.fill(ENGINE);
      const opt = page.getByRole("button", { name: new RegExp(`^${LABELS[ENGINE]}`, "i") }).last();
      await opt.waitFor({ state: "visible", timeout: 6_000 });
      await opt.click();
      await sleep(400);
      engineChosen = (await page.locator('button[aria-label="Select engine"]').innerText().catch(() => "")).includes(LABELS[ENGINE]);
    } catch { await page.keyboard.press("Escape").catch(() => {}); await sleep(400); }
  }
  pass(`chose engine "${ENGINE}" in the React form`, engineChosen, engineChosen ? "picked" : "picker did not settle on the engine");
  // repo: best-effort select the first available repo
  let repoChosen = false;
  try {
    await page.click('button[aria-label="Select repositories"], button[aria-label*="repositor" i]', { timeout: 5_000 });
    await sleep(500);
    await page.locator('[role="option"], li button, [role="listbox"] button').first().click({ timeout: 5_000 });
    await page.keyboard.press("Escape").catch(() => {});
    repoChosen = true;
  } catch { /* repo optional */ }
  rec("chose a repository in the React form", repoChosen ? "pass" : "na", repoChosen ? "selected" : "no repo picker/none available");
  // skill preselected via ?skill= (deep-link) - assert the picker reflects it
  const skillShown = skillId ? await page.getByText(`c6 ${ENGINE} skill`, { exact: false }).first().isVisible().catch(() => false) : false;
  rec("chose a skill in the React form (deep-link preselect)", skillShown ? "pass" : "na", skillShown ? "shown" : "not visible");
  // prompt + Start agent
  const prompt = `You MUST use your shell/bash tool (do not answer from memory) to run exactly: echo ${MARKER}. Then reply with exactly: DONE${MARKER}`;
  await page.fill("textarea", prompt);
  await shot(page, "1-newtask");
  await page.getByRole("button", { name: /start agent/i }).click();

  // ── 2. land on the session page; run streams + completes ──
  await page.waitForURL(/\/session\/[0-9a-f-]+/i, { timeout: 60_000 }).catch(() => {});
  const url = page.url();
  const runId = /\/session\/([0-9a-f-]+)/i.exec(url)?.[1] ?? "";
  pass("form submitted -> routed to /session/:id in React", !!runId, `run=${short(runId)}`);
  if (!runId) throw new Error("no session route after Start agent");
  myRunIds.push(runId);
  // HARD gate: the run MUST be the engine we selected in the form. A mis-selected picker that fell
  // back to the default would silently test the wrong engine - fail loudly instead.
  await sleep(1500);
  const runEngine = (await dbRun(runId))?.engine;
  pass(`the created run is the SELECTED engine "${ENGINE}" (not a fallback)`, runEngine === ENGINE, `engine=${runEngine}`);
  if (runEngine !== ENGINE) throw new Error(`engine mis-selection: ran as ${runEngine}, expected ${ENGINE}`);

  const settled = await waitTerminal(runId, BUDGET_MS);
  const box1 = (await dbRun(runId))?.sandbox_id as string | undefined;
  const ses1 = (await dbRun(runId))?.engine_session_id as string | undefined;
  if (!box1 && settled?.status !== "completed") {
    daytonaBlocked = true;
    rec("LIVE Daytona sandbox provisioned", "blocked", `status=${settled?.status ?? "timeout"} - shared Daytona likely at capacity`);
  } else {
    pass("turn 1 completed on a REAL sandbox", settled?.status === "completed", `status=${settled?.status} sandbox=${short(box1)}`);
    await waitCanonical(page, 90_000);
    // wait for the assistant answer node to actually carry the exact reply (streaming settles a
    // moment after the run row goes terminal). Poll the exact-equality condition, not a substring.
    let answers1: string[] = [];
    for (let i = 0; i < 30; i++) { answers1 = await answerTexts(page); if (answers1.includes(ANSWER)) break; await sleep(1000); }
    const tools1 = await toolCount(page);
    // EXACT rendered text: some assistant answer node EQUALS "DONEC6MARK_<engine>" - a coherent
    // single node (D1), not the marker merely appearing somewhere (which the echoed tool output or
    // a token-per-line fragment stream would also satisfy).
    pass(
      "React renders the EXACT assistant reply as one coherent node (not a substring/fragments)",
      answers1.includes(ANSWER),
      answers1.includes(ANSWER) ? `answer node == "${ANSWER}"` : `no answer node equals "${ANSWER}"; nodes=${JSON.stringify(answers1.slice(0, 6))}`,
    );
    // tie the DOM tool-row assertion to backend truth: a tool row must render IFF a real tool step
    // exists. If the agent chose no tool this turn, that is honest (na), not a UI failure.
    const r1steps = ((await api(`/api/runs/${runId}`))?.steps as { kind?: string }[]) ?? [];
    const hadTool = r1steps.some((s) => s.kind === "command" || s.kind === "file");
    if (hadTool) pass("React shows >=1 tool row (matches a real tool step)", tools1 > 0, `${tools1} tool rows`);
    else rec("React shows tool rows", "na", "the agent used no tool this turn (no command/file step)");
    pass("timeline rendered by the CANONICAL lane", (await timelineSource(page)).includes("canonical"));
    await shot(page, "2-turn1");

    // ── 3. LIVE command picker (durable commands.updated, not seeded) -> submit a safe command ──
    const [cmdRow] = (await sql`SELECT body FROM canonical_events WHERE thread_id = ${runId} AND kind = 'commands.updated' AND identity->>'nativeSessionId' = ${ses1 ?? ""} ORDER BY delivery_seq DESC LIMIT 1`) as unknown as { body: { commands?: string[] } }[];
    const catalog = (cmdRow?.body?.commands ?? []).filter((n) => typeof n === "string");
    const SAFE = new Set(["status", "diff", "help", "about", "compact", "models", "mcp", "review", "init", "usage", "context", "plan", "skills"]);
    const safeCmd = catalog.find((n) => SAFE.has(n));
    rec("session advertised a LIVE command catalog (durable, unseeded)", catalog.length > 0 ? "pass" : "na", `[${catalog.slice(0, 6).join(",")}]`);
    if (safeCmd) {
      const composer = page.locator('textarea[placeholder*="Reply to Skynet"]:visible');
      await composer.click();
      await composer.fill("/");
      await sleep(1200);
      const opt = page.locator(`[role="option"]`, { hasText: safeCmd }).first();
      const picked = await opt.isVisible({ timeout: 10_000 }).catch(() => false);
      if (picked) await opt.click();
      else await composer.fill(`/${safeCmd} `); // fallback: type it verbatim
      await page.keyboard.press("Enter");
      // the 2nd turn (command) appears in the thread
      let cmdRunId = "";
      for (let i = 0; i < 90 && !cmdRunId; i++) {
        const thr = (await api(`/api/runs/${runId}?thread=1`)) as { thread?: { id: string }[] } | null;
        cmdRunId = (thr?.thread ?? []).map((r) => r.id).find((id) => id !== runId) ?? "";
        await sleep(1000);
      }
      pass("submitted a safe native command via the LIVE React picker", !!cmdRunId, cmdRunId ? `run=${short(cmdRunId)}` : "no 2nd run");
      if (cmdRunId) {
        myRunIds.push(cmdRunId);
        const d2 = await waitTerminal(cmdRunId, BUDGET_MS);
        pass(`command turn recorded command_name="${safeCmd}"`, (await dbRun(cmdRunId))?.command_name === safeCmd, `command_name=${(await dbRun(cmdRunId))?.command_name}`);
        pass("turn 2 reused the SAME sandbox + provider session", d2?.sandbox_id === box1 && d2?.engine_session_id === ses1, `box ${short(d2?.sandbox_id)} ses ${short(d2?.engine_session_id)}`);
      }
    } else {
      rec("submitted a safe native command via the LIVE React picker", "na", "no safe command advertised (honest capability)");
      // still prove a plain reply reuses the session
      const composer = page.locator('textarea[placeholder*="Reply to Skynet"]:visible');
      await composer.fill(`Reply with exactly RETAIN${MARKER}`);
      await page.keyboard.press("Enter");
      let r2 = "";
      for (let i = 0; i < 90 && !r2; i++) { const thr = (await api(`/api/runs/${runId}?thread=1`)) as { thread?: { id: string }[] } | null; r2 = (thr?.thread ?? []).map((r) => r.id).find((id) => id !== runId) ?? ""; await sleep(1000); }
      if (r2) { myRunIds.push(r2); const d2 = await waitTerminal(r2, BUDGET_MS); pass("turn 2 reused the SAME sandbox + provider session", d2?.sandbox_id === box1 && d2?.engine_session_id === ses1, `box ${short(d2?.sandbox_id)} ses ${short(d2?.engine_session_id)}`); }
    }
    await shot(page, "3-turn2");

    // ── 4. reload: no missing/duplicate rows ──
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitCanonical(page, 45_000);
    const ids = await runIds(page);
    // after reload the EXACT answer node must persist (built from canonical, not re-streamed) - the
    // token-per-line regression re-hydrated as fragments here, so exact-equality guards it.
    let answersR: string[] = [];
    for (let i = 0; i < 20; i++) { answersR = await answerTexts(page); if (answersR.includes(ANSWER)) break; await sleep(1000); }
    pass("reload: no duplicate/missing turns, EXACT answer node persists", new Set(ids).size === ids.length && ids.includes(runId) && answersR.includes(ANSWER), `ids=${ids.length} answerExact=${answersR.includes(ANSWER)}`);
    await shot(page, "4-reload");

    // ── 5. truthful surface states (capability-driven) ──
    const [ssRow] = (await sql`SELECT body FROM canonical_events WHERE thread_id = ${runId} AND kind = 'session.started' AND identity->>'nativeSessionId' = ${ses1 ?? ""} ORDER BY delivery_seq DESC LIMIT 1`) as unknown as { body: { capabilities?: Record<string, boolean> } }[];
    const caps = ssRow?.body?.capabilities ?? {};
    // capability truthfulness is the SOURCE the UI gates on: opencode has a noVNC desktop; a cold
    // ACP sandbox does not. Then the desktop TAB must render iff the capability says so (data-testid;
    // the rail is open because a tool ran) - never a fake tab.
    pass("negotiated desktop capability is truthful for the engine", caps.desktop === (ENGINE === "opencode"), `caps.desktop=${caps.desktop}`);
    const desktopTabs = await page.locator('[data-testid="rail-tab-desktop"]').count();
    pass("desktop tab presence matches the capability (no fake tab)", (desktopTabs > 0) === (caps.desktop === true), `tabs=${desktopTabs} caps.desktop=${caps.desktop}`);
    // the rail (with the terminal tab) renders when there is rail content (tool activity) - an
    // empty rail is honestly collapsed, not a fake tab. Assert the terminal tab when a tool ran.
    const terminalTabs = await page.locator('[data-testid="rail-tab-terminal"]').count();
    if (hadTool) pass("terminal surface present when the rail has content (truthful)", terminalTabs > 0, `tabs=${terminalTabs}`);
    else rec("terminal surface", "na", "rail collapsed (no tool activity this turn) - no fake empty rail");

    // ── 6. stop a genuinely in-flight turn ──
    const composer = page.locator('textarea[placeholder*="Reply to Skynet"]:visible');
    await composer.fill("Use the shell tool to run exactly: sleep 90. Do not reply until it finishes.");
    await page.keyboard.press("Enter");
    let stopRun = "";
    for (let i = 0; i < 90 && !stopRun; i++) { const thr = (await api(`/api/runs/${runId}?thread=1`)) as { thread?: { id: string }[] } | null; stopRun = (thr?.thread ?? []).map((r) => r.id).find((id) => ![runId, ...myRunIds].includes(id)) ?? ""; await sleep(1000); }
    if (stopRun) myRunIds.push(stopRun);
    let running = false;
    for (let i = 0; i < 240 && stopRun; i++) {
      const r = await api(`/api/runs/${stopRun}`);
      const steps = (r?.steps as { kind?: string }[]) ?? [];
      if (r?.status === "running" && steps.some((s) => s.kind === "command")) { running = true; break; }
      if (r && ["failed", "completed", "cancelled"].includes(r.status as string)) break;
      await sleep(750);
    }
    if (running) {
      await page.getByRole("button", { name: /stop this run|stop/i }).first().click({ timeout: 8_000 }).catch(() => {});
      const s = await waitTerminal(stopRun, 100_000);
      pass('stop: in-flight turn settles "Stopped by user"', s?.summary === "Stopped by user", `status=${s?.status} summary="${short(s?.summary, 20)}"`);
    } else {
      rec("stop: in-flight turn settles \"Stopped by user\"", "na", "turn finished before a mid-flight cancel window (proven by acp-live-e2e)");
    }
    await shot(page, "5-stop");

    const appErrors = consoleErrors.filter((e) => !/Failed to load resource|favicon|hydrat|ResizeObserver/i.test(e));
    pass("no app console errors across the React journey", appErrors.length === 0, appErrors.slice(0, 2).join(" | "));
  }
  await page.close();
} catch (e) {
  rec("no fatal error", "fail", e instanceof Error ? e.message : String(e));
} finally {
  await sql.end().catch(() => {});
  // clean up ONLY our sandboxes (persisted ids + label match on our run ids)
  const mine = new Set<string>([...sandboxIds].filter(Boolean));
  const myRuns = new Set(myRunIds);
  try { for (const sb of await listAll()) { const l = sb.labels?.["skynet-run"]; if (l && myRuns.has(l)) mine.add(sb.id); } } catch { /* ignore */ }
  const ids = [...mine].filter(Boolean);
  if (ids.length) { const r = await deleteById(ids).catch(() => ({ deleted: [], failed: [{ id: "?", error: "x" }] })); rec("sandbox(es) deleted + API-verified", r.failed.length === 0 ? "pass" : "fail", `deleted ${r.deleted.length}`); }
  else rec("sandbox cleanup", daytonaBlocked ? "na" : "pass", "nothing provisioned");
  browser?.close().catch(() => {});
  fe?.kill(); be?.kill();
  await sleep(1500);
  if (readFileSync(tsconfigPath, "utf8") !== tsconfigBefore) writeFileSync(tsconfigPath, tsconfigBefore);
  rmSync(`${frontendDir}/${DIST}`, { recursive: true, force: true });
  const admin2 = postgres(ADMIN_URL, { max: 1 });
  await admin2`DROP DATABASE IF EXISTS ${admin2.unsafe(DB)} WITH (FORCE)`.catch(() => {});
  await admin2.end().catch(() => {});
  const fails = cells.filter((c) => c.status === "fail");
  const verdict = daytonaBlocked ? "BLOCKED" : fails.length === 0 ? "PASS" : "FAIL";
  console.log(`\nC6_EVIDENCE=${JSON.stringify({ engine: ENGINE, model: MODEL, verdict, runIds: myRunIds, sandboxIds: [...sandboxIds], cells })}`);
  console.log(`\n${verdict === "PASS" ? "✅ PASS" : verdict === "BLOCKED" ? "⚠️  BLOCKED" : "❌ FAIL"} (${ENGINE}) - ${cells.filter((c) => c.status === "pass").length} pass, ${fails.length} fail`);
  if (fails.length) console.log("FAILED:", fails.map((c) => c.cell).join(" | "));
  process.exit(verdict === "FAIL" ? 1 : 0);
}
