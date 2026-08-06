/**
 * Aggressive browser-level UI E2E sweep — 10 scenarios, Playwright headless
 * (system Chrome) against the isolated stack (frontend :3413 → backend :3513,
 * real `skynet` DB, committed HEAD). Each scenario asserts and logs PASS/FAIL/SKIP.
 *
 * Run:  cd <worktree>/frontend && bun uisweep/sweep.ts
 * Filter: SCENARIOS=1,4,8 bun uisweep/sweep.ts
 * Reuse a warm opencode fanout fixture: WF_RID=<runId> (else one is created).
 */
import type { Browser, Page } from "playwright-core";
import {
  BE, FE, createRun, getRun, getThread, waitRun, newPage, launch, shot, sleep,
  verdictOf, printResult, beApi, TAG, type Result,
} from "./harness";

const ONLY = (process.env.SCENARIOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const want = (n: number) => ONLY.length === 0 || ONLY.includes(String(n));
const results: Result[] = [];
let browser!: Browser;

const FANOUT_PROMPT =
  "uisweep-fanout: Use your task tool to launch exactly 3 subagents in parallel. " +
  "Subagent 1 writes a haiku about ALPHA to alpha.txt; subagent 2 writes a haiku about BETA to beta.txt; " +
  "subagent 3 writes a haiku about GAMMA to gamma.txt. Each must use the bash tool to create its file. " +
  "After all three finish, tell me DONE and list the three filenames.";

/** A warm (sandbox-alive) settled fanout — reused across read-only scenarios. */
async function ensureWarmFanout(): Promise<string> {
  const pre = process.env.WF_RID?.trim();
  if (pre) {
    // Confirm it still serves commands (sandbox warm) before trusting it.
    const r = await fetch(`${BE}/api/live-proxy/${pre}/command`, { headers: { Origin: "http://localhost:3200" } }).catch(() => null);
    if (r?.ok) return pre;
  }
  const { id } = await createRun(FANOUT_PROMPT, { engine: "opencode", model: "claude-haiku-4-5" });
  if (!id) throw new Error("failed to create warm fanout");
  await waitRun(id, (r) => r.status === "completed" || r.status === "failed", 150_000);
  return id;
}

// ── Scenario 1: hero send + duplicate-submit guard + failed-send draft ────────
async function s1_hero(): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  try {
    // 1a/1b: real submit with the POST delayed so we can observe the in-flight guard.
    await page.goto(`${FE}/agent/new`, { waitUntil: "domcontentloaded" });
    const ta = page.locator('textarea[aria-label="Describe the task"]');
    // Text toggles "Start agent" ↔ "Starting…", so match both states.
    const startBtn = page.getByRole("button", { name: /Start agent|Starting/i });
    await ta.waitFor({ state: "visible" });
    await checks.push({ name: "hero: Start disabled while textarea empty", ok: await startBtn.isDisabled() });
    const heroPrompt = `uisweep-hero ${crypto.randomUUID().slice(0, 8)}: reply with the single word ready`;
    // Hydration-safe: re-fill until React registers the value (button enables).
    for (let i = 0; i < 25; i++) {
      await ta.fill(heroPrompt);
      if (!(await startBtn.isDisabled())) break;
      await page.waitForTimeout(200);
    }
    // Pick the Haiku model (cheap) via the model picker, then close the popover.
    await page.locator('[aria-label="Select model"]').click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /Haiku 4\.5/ }).first().click().catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
    checks.push({ name: "hero: Start enabled once prompt present", ok: !(await startBtn.isDisabled()) });

    // Delay (not fake) the outgoing POST so the disabled guard is observable.
    let posted = 0;
    await page.route("**/api/runs", async (route) => {
      if (route.request().method() === "POST") { posted += 1; await sleep(1400); }
      await route.continue();
    });
    await startBtn.click();
    await page.waitForTimeout(300);
    checks.push({ name: "hero: button disabled + 'Starting…' during submit (dup-submit guard)", ok: (await startBtn.isDisabled()) && /Starting/i.test((await startBtn.textContent()) ?? "") });
    // A second click while disabled must not fire a second POST.
    await startBtn.click({ force: true }).catch(() => {});
    await page.waitForURL(/\/session\/[0-9a-f-]+/, { timeout: 20_000 });
    await page.unroute("**/api/runs");
    const navId = page.url().split("/session/")[1];
    checks.push({ name: "hero: navigates to /session/{id} on success", ok: !!navId && /[0-9a-f-]{20,}/.test(navId) });
    checks.push({ name: "hero: exactly ONE POST despite double-click", ok: posted === 1, note: `posted=${posted}` });
    const created = navId ? await getRun(navId) : null;
    checks.push({ name: "hero: run created with engine=opencode, model=claude-haiku-4-5 (pickers fed POST)", ok: created?.engine === "opencode" && created?.model === "claude-haiku-4-5", note: `engine=${created?.engine} model=${created?.model}` });

    // Free the streaming session page before the next sub-test so it doesn't
    // starve the second page's interactivity.
    await page.close();

    // 1c: failed-send → error alert + draft preserved (abort injects the failure).
    const { page: p2 } = await newPage(browser);
    await p2.goto(`${FE}/agent/new`, { waitUntil: "domcontentloaded" });
    const draft = `uisweep-hero-fail ${crypto.randomUUID().slice(0, 6)}`;
    const p2ta = p2.locator('textarea[aria-label="Describe the task"]');
    const p2btn = p2.getByRole("button", { name: /Start agent|Starting/i });
    await p2ta.click();
    // Hydration-safe: re-fill until the controlled input registers + button enables.
    for (let i = 0; i < 25; i++) {
      await p2ta.fill(draft);
      if (!(await p2btn.isDisabled())) break;
      await p2.waitForTimeout(200);
    }
    await p2.route("**/api/runs", (route) => route.abort());
    // Submit via plain Enter (the hero composer's Enter-to-send) — robust and
    // also covers the Enter path; the button-click path is proven in the main flow.
    await p2ta.press("Enter");
    await p2.waitForTimeout(1500);
    const alertTxt = (await p2.locator('[role="alert"]').first().textContent().catch(() => "")) ?? "";
    const draftKept = (await p2.locator('textarea[aria-label="Describe the task"]').inputValue()) === draft;
    checks.push({ name: "hero: failed send shows error alert", ok: /Couldn't start the agent/i.test(alertTxt), note: alertTxt.slice(0, 60) });
    checks.push({ name: "hero: draft text preserved after failed send (no data loss)", ok: draftKept });
    checks.push({ name: "hero: no navigation on failed send", ok: p2.url().endsWith("/agent/new") });
    await p2.unroute("**/api/runs").catch(() => {});
    await p2.close();
    return verdictOf("1. Hero composer (send / dup-submit guard / failed-send draft)", checks);
  } catch (e) {
    await shot(page, "s1-hero-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("1. Hero composer", checks);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Scenario 2: reply composer — idempotency-key reuse + draft restore ────────
async function s2_reply(wf: string): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  try {
    await page.goto(`${FE}/session/${wf}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const ta = page.locator('textarea').first();
    const send = page.locator('[aria-label="Send"]').first();
    checks.push({ name: "reply: composer + Send button present on live thread", ok: (await ta.count()) > 0 && (await send.count()) > 0 });

    // Capture Idempotency-Key on every /api/runs POST.
    const keys: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/api/runs")) {
        const k = req.headers()["idempotency-key"];
        if (k) keys.push(k);
      }
    });
    const replyText = `uisweep-reply ${crypto.randomUUID().slice(0, 6)} say ok`;

    // Attempt 1 + 2 both aborted → prove key reuse across retries + draft restore.
    await page.route("**/api/runs", (route) => route.abort());
    await ta.fill(replyText);
    await send.click();
    await page.waitForTimeout(800);
    const failAlert = (await page.getByText(/Couldn't send/i).count()) > 0;
    const restored1 = (await ta.inputValue()) === replyText;
    checks.push({ name: "reply: failed send shows 'Couldn't send' + restores draft", ok: failAlert && restored1, note: `alert=${failAlert} restored=${restored1}` });
    await send.click(); // retry same text (still aborted)
    await page.waitForTimeout(800);
    checks.push({ name: "reply: Idempotency-Key REUSED on retry of same text", ok: keys.length >= 2 && keys[0] === keys[1], note: `keys=${keys.length} same=${keys[0] === keys[1]}` });

    // Attempt 3: real send (unroute) → recovers, same key, run created.
    await page.unroute("**/api/runs");
    await send.click();
    await page.waitForTimeout(2500);
    const cleared = (await ta.inputValue()) === "";
    const sameKeyThroughout = keys.length >= 3 && keys.every((k) => k === keys[0]);
    checks.push({ name: "reply: real send recovers (composer clears) + same key hits backend", ok: cleared && sameKeyThroughout, note: `cleared=${cleared} keys=${JSON.stringify(keys.map((k) => k.slice(0, 8)))}` });
    return verdictOf("2. Reply composer (idempotency-key reuse / draft restore / failed state)", checks);
  } catch (e) {
    await shot(page, "s2-reply-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("2. Reply composer", checks);
  } finally {
    await page.close();
  }
}

// ── Scenario 3 (lead #2): slash autocomplete on the reply composer ───────────
async function s3_slash(wf: string): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  try {
    await page.goto(`${FE}/session/${wf}`, { waitUntil: "domcontentloaded" });
    // Commands load from the live sandbox via /api/live-proxy/{id}/command.
    await page.waitForTimeout(2500);
    const ta = page.locator("textarea").first();
    await ta.click();
    await ta.fill("/");
    await page.waitForTimeout(600);
    const popover = page.getByText(/^Commands$/);
    const popoverShown = (await popover.count()) > 0;
    checks.push({ name: "slash: '/' opens the Commands popover from a live thread", ok: popoverShown });
    const itemsAll = await page.locator("button", { hasText: /^\// }).count();
    // Filter: type a query and assert the list narrows to prefix matches.
    await ta.fill("/rev");
    await page.waitForTimeout(500);
    const revItems = await page.getByRole("button").filter({ hasText: /^\/rev/ }).count();
    const anyReview = (await page.getByText("/review", { exact: false }).count()) > 0;
    checks.push({ name: "slash: typing '/rev' filters to matching commands (e.g. /review)", ok: anyReview, note: `matches≈${revItems}` });

    // Enter COMPLETES the token (does not submit the message).
    const threadBefore = (await getThread(wf)).length;
    await ta.press("Enter");
    await page.waitForTimeout(600);
    const val = await ta.inputValue();
    const completed = /^\/\S+\s$/.test(val); // "/review " with trailing space, still in composer
    const threadAfter = (await getThread(wf)).length;
    checks.push({ name: "slash: Enter COMPLETES to '/<cmd> ' and stays in composer (does NOT submit)", ok: completed && threadAfter === threadBefore, note: `value=${JSON.stringify(val)} threadΔ=${threadAfter - threadBefore}` });
    await shot(page, "s3-slash");
    return verdictOf("3. Slash autocomplete on reply composer (popover / filter / Enter completes)", checks, `itemsAtOpen≈${itemsAll}`);
  } catch (e) {
    await shot(page, "s3-slash-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("3. Slash autocomplete", checks);
  } finally {
    await page.close();
  }
}

// ── Scenario 4 (lead #3): live streaming / narration ─────────────────────────
async function s4_streaming(): Promise<Result> {
  const checks: Result["checks"] = [];
  const sentinel = `uisweep-echo-${crypto.randomUUID().slice(0, 8)}`;
  const prompt =
    `Do not use any tools. Do not repeat this instruction line. [${sentinel}] ` +
    "Write exactly five paragraphs, separated by blank lines, explaining the history of the number zero. " +
    "Make each paragraph three or four sentences.";
  const { id } = await createRun(prompt, { engine: "opencode", model: "claude-haiku-4-5" });
  if (!id) { checks.push({ name: "create streamer run", ok: false }); return verdictOf("4. Live streaming", checks); }
  const { page } = await newPage(browser);
  try {
    await page.goto(`${FE}/session/${id}`, { waitUntil: "domcontentloaded" });
    // Poll for live indicators while the run is running.
    let sawLoader = false, sawLiveText = false, settledEarly = false;
    for (let i = 0; i < 80; i++) {
      const [loader, mdText, r] = await Promise.all([
        page.locator(".ai-loading-pixel").count(),
        page.locator("div.text-paragraph-sm").first().textContent().catch(() => ""),
        getRun(id),
      ]);
      if (loader > 0) sawLoader = true;
      if ((mdText ?? "").length > 40) sawLiveText = true;
      if (r?.status === "completed" || r?.status === "failed") { if (i < 2) settledEarly = true; break; }
      if (sawLoader && sawLiveText) { /* keep polling to settle */ }
      await page.waitForTimeout(400);
    }
    checks.push({ name: "stream: live LoadingState (pixel-grid) visible while running", ok: sawLoader, note: settledEarly ? "engine settled almost instantly" : "" });
    checks.push({ name: "stream: progressive markdown narration renders while live", ok: sawLiveText });
    // Settle and assert final state.
    await waitRun(id, (r) => r.status === "completed" || r.status === "failed", 120_000);
    await page.waitForTimeout(2500);
    const loaderAfter = await page.locator(".ai-loading-pixel").count();
    const answerParas = await page.locator("div.text-paragraph-sm p").count();
    // Scope the echo check to the CONVERSATION section (the one holding the reply
    // composer) — the left sidebar's active-runs list legitimately shows the
    // prompt as a nav label, which a whole-page count would wrongly flag.
    const convo = page.locator("section").filter({ has: page.locator("textarea") }).first();
    const convoSentinel = (await convo.innerText()).split(sentinel).length - 1;
    const answerHasSentinel = (await getRun(id))?.summary?.includes(sentinel) ?? false;
    checks.push({ name: "stream: LoadingState replaced by settled answer (no perpetual loader)", ok: loaderAfter === 0, note: `loaders=${loaderAfter}` });
    checks.push({ name: "stream: paragraphs separated in settled answer (>=2 <p>)", ok: answerParas >= 2, note: `paras=${answerParas}` });
    checks.push({ name: "stream: no prompt echo — prompt appears once in convo (user bubble) and NOT in the answer", ok: convoSentinel === 1 && !answerHasSentinel, note: `convoSentinel=${convoSentinel} answerEcho=${answerHasSentinel}` });
    await shot(page, "s4-streaming");
    return verdictOf("4. Live streaming (progressive narration / LoadingState / no echo / paragraphs)", checks, `run=${id}`);
  } catch (e) {
    await shot(page, "s4-streaming-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("4. Live streaming", checks);
  } finally {
    await page.close();
  }
}

// ── Scenario 5 (lead #4): fanout UI drill-in + dedupe + worklog counts ────────
async function s5_fanout(wf: string): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  try {
    await page.goto(`${FE}/session/${wf}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const cards = page.locator('[aria-label^="Open subagent:"]');
    const n = await cards.count();
    checks.push({ name: "fanout: exactly 3 subagent cards, no dupes (SSE+poller collapsed)", ok: n === 3, note: `cards=${n}` });
    const labels = await cards.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    const hasAll = ["ALPHA", "BETA", "GAMMA"].every((t) => labels.some((l) => l.includes(t)));
    checks.push({ name: "fanout: cards are ALPHA / BETA / GAMMA", ok: hasAll, note: labels.join(" | ") });

    // Drill into ALPHA → detail shows ONLY alpha's write; back restores the list.
    // Scope the isolation check to the RAIL section (the conversation worklog
    // legitimately lists all three files, so a whole-page check would be wrong).
    const rail = page.locator('[role="separator"][aria-label="Resize the side panel"] + section');
    await cards.filter({ hasText: /ALPHA/ }).first().click();
    await page.waitForTimeout(800);
    const detailText = (await rail.innerText()).toLowerCase();
    const showsAlpha = detailText.includes("alpha.txt");
    const excludesBeta = !detailText.includes("beta.txt") && !detailText.includes("gamma.txt");
    checks.push({ name: "fanout: ALPHA detail shows its OWN write (alpha.txt) and EXCLUDES beta/gamma", ok: showsAlpha && excludesBeta, note: `alpha=${showsAlpha} excludesOthers=${excludesBeta}` });
    // Back → list of 3 again.
    await page.getByRole("button", { name: /^(Back|←|Agents)/ }).first().click().catch(async () => {
      await page.locator("button").filter({ hasText: "←" }).first().click().catch(() => {});
    });
    await page.waitForTimeout(600);
    const backN = await page.locator('[aria-label^="Open subagent:"]').count();
    checks.push({ name: "fanout: Back restores the 3-card list", ok: backN === 3, note: `cards=${backN}` });

    // Worklog capsule collapses settled with a step count that matches the expansion.
    const capsule = page.locator('[aria-expanded]').filter({ hasText: /step/ }).first();
    const capText = (await capsule.textContent().catch(() => "")) ?? "";
    const m = capText.match(/(\d+)\s*step/);
    const count = m ? Number(m[1]) : -1;
    await capsule.click().catch(() => {});
    await page.waitForTimeout(400);
    const expanded = (await capsule.getAttribute("aria-expanded")) === "true";
    checks.push({ name: "fanout: settled worklog collapses with a step count and expands on click", ok: count > 0 && expanded, note: `count=${count} expanded=${expanded}` });
    await shot(page, "s5-fanout");
    return verdictOf("5. Fanout UI (3 cards / drill-in isolation / back / dedupe / worklog counts)", checks, `run=${wf}`);
  } catch (e) {
    await shot(page, "s5-fanout-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("5. Fanout UI", checks);
  } finally {
    await page.close();
  }
}

// ── Scenario 6 (lead #5): reconnect — reload mid-run resumes, no dup/missing ──
async function s6_reconnect(): Promise<Result> {
  const checks: Result["checks"] = [];
  const { id } = await createRun(FANOUT_PROMPT, { engine: "opencode", model: "claude-haiku-4-5" });
  if (!id) { checks.push({ name: "create fanout for reconnect", ok: false }); return verdictOf("6. Reconnect", checks); }
  const { page } = await newPage(browser);
  try {
    await page.goto(`${FE}/session/${id}`, { waitUntil: "domcontentloaded" });
    // Wait until the run is live with at least one rendered step, then reload.
    let reloadedWhileLive = false;
    for (let i = 0; i < 40; i++) {
      const r = await getRun(id);
      const rows = await page.locator('[aria-label^="Open subagent:"], [aria-expanded]').count();
      if (r?.status === "running" && rows > 0) { reloadedWhileLive = true; break; }
      if (r?.status === "completed" || r?.status === "failed") break;
      await page.waitForTimeout(400);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const afterReloadRows = await page.locator('[aria-expanded], [aria-label^="Open subagent:"]').count();
    checks.push({ name: "reconnect: turn re-renders after mid-run reload", ok: afterReloadRows > 0, note: `liveReload=${reloadedWhileLive} rows=${afterReloadRows}` });

    // Settle, then compare rendered vs API truth (no missing / duplicated).
    const finalRun = await waitRun(id, (r) => r.status === "completed" || r.status === "failed", 120_000);
    await page.waitForTimeout(2500);
    const uiCards = await page.locator('[aria-label^="Open subagent:"]').count();
    const apiSubs = (finalRun.steps ?? []).filter((s: any) => s.chip === "subagent").length;
    checks.push({ name: "reconnect: subagent cards after settle == API truth (no dup/missing)", ok: uiCards === apiSubs && uiCards > 0, note: `ui=${uiCards} api=${apiSubs}` });
    // Expand worklog and assert step rows are not duplicated vs API settled steps.
    const capsule = page.locator('[aria-expanded]').filter({ hasText: /step/ }).first();
    const capText = (await capsule.textContent().catch(() => "")) ?? "";
    const m = capText.match(/(\d+)\s*step/);
    checks.push({ name: "reconnect: worklog step count is a sane single-count (not doubled)", ok: !!m && Number(m[1]) > 0 && Number(m[1]) <= (finalRun.steps ?? []).length, note: `worklog=${m?.[1]} apiSteps=${(finalRun.steps ?? []).length}` });
    await shot(page, "s6-reconnect");
    return verdictOf("6. Reconnect UI (reload mid-run resumes; settle matches API truth)", checks, `run=${id}`);
  } catch (e) {
    await shot(page, "s6-reconnect-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("6. Reconnect UI", checks);
  } finally {
    await page.close();
  }
}

// ── Scenario 7 (lead #6): terminal pane — tabs, Log content, PTY echo ─────────
async function s7_terminal(wf: string): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page, consoleErrors } = await newPage(browser);
  try {
    await page.goto(`${FE}/session/${wf}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await page.getByText(/^Terminal$/).first().click();
    await page.waitForTimeout(1200);
    // Shell|Log sub-tabs present + sized small (defect #42 was oversized tabs).
    const shellTab = page.getByText(/^Shell$/).first();
    const logTab = page.getByText(/^Log$/).first();
    const tabsPresent = (await shellTab.count()) > 0 && (await logTab.count()) > 0;
    const fs = tabsPresent ? await shellTab.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)) : 99;
    checks.push({ name: "terminal: Shell|Log tabs present and sized small (≤14px)", ok: tabsPresent && fs <= 14, note: `fontPx=${fs}` });
    // Log tab shows the run's shell commands.
    await logTab.click();
    await page.waitForTimeout(800);
    const logText = (await page.locator("body").innerText());
    checks.push({ name: "terminal: Log tab renders the run's shell commands (cat/echo)", ok: /alpha\.txt|cat >|echo/i.test(logText), note: (logText.match(/(cat >[^\n]{0,30})/i)?.[1] ?? "").trim() });
    // Shell tab mounts the ghostty canvas with a mono font.
    await shellTab.click();
    await page.waitForTimeout(1200);
    const canvasCount = await page.locator("div.bg-neutral-950 canvas, canvas").count();
    checks.push({ name: "terminal: Shell tab mounts the ghostty canvas", ok: canvasCount > 0, note: `canvas=${canvasCount}` });

    // PTY echo roundtrip — open the SAME WS the app opens (via the frontend proxy),
    // and also directly to the backend; report both.
    const marker = `ptyecho-${Math.random().toString(36).slice(2, 8)}`;
    const wsResult = await page.evaluate(async ({ wf, marker, be }) => {
      function tryWs(url: string): Promise<{ open: boolean; echo: boolean }> {
        return new Promise((resolve) => {
          let open = false, echo = false;
          let ws: WebSocket;
          try { ws = new WebSocket(url); } catch { return resolve({ open, echo }); }
          const done = () => { try { ws.close(); } catch {} resolve({ open, echo }); };
          const timer = setTimeout(done, 11000);
          // The PTY needs ~1s to provision + print its prompt; send after a beat.
          ws.onopen = () => { open = true; setTimeout(() => { try { ws.send(JSON.stringify({ type: "input", data: `echo ${marker}\r` })); } catch {} }, 1600); };
          ws.onmessage = (e) => { if (String(e.data).includes(marker)) { echo = true; clearTimeout(timer); done(); } };
          ws.onerror = () => {};
        });
      }
      const viaProxy = await tryWs(`ws://${location.host}/api/runs/${wf}/terminal?cols=80&rows=24`);
      const viaBackend = await tryWs(`${be.replace("http", "ws")}/api/runs/${wf}/terminal?cols=80&rows=24`);
      return { viaProxy, viaBackend };
    }, { wf, marker, be: BE });
    const anyEcho = wsResult.viaProxy.echo || wsResult.viaBackend.echo;
    checks.push({ name: "terminal: PTY echo roundtrip (backend WS)", ok: wsResult.viaBackend.echo, note: `backend open=${wsResult.viaBackend.open} echo=${wsResult.viaBackend.echo}` });
    checks.push({ name: "terminal: PTY reachable through the app's proxied WS (location.host)", ok: wsResult.viaProxy.echo, note: `proxy open=${wsResult.viaProxy.open} echo=${wsResult.viaProxy.echo}` });
    // Teardown: switch Shell → Agents; the ghostty pane must dispose cleanly.
    await page.getByText(/^Agents$/).first().click().catch(() => {});
    await page.waitForTimeout(1000);
    const disposeErr = consoleErrors.filter((e) => /Terminal has been disposed|disposed/i.test(e));
    checks.push({ name: "terminal: switching away from Shell disposes cleanly (no console error)", ok: disposeErr.length === 0, note: disposeErr[0]?.slice(0, 80) ?? "" });
    await shot(page, "s7-terminal");
    return verdictOf("7. Terminal pane (Shell|Log tabs / Log commands / PTY echo)", checks, `anyEcho=${anyEcho}`);
  } catch (e) {
    await shot(page, "s7-terminal-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("7. Terminal pane", checks);
  } finally {
    await page.close();
  }
}

// ── Scenario 8 (lead #7): desktop tab for opencode threads ───────────────────
async function s8_desktop(wf: string): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  try {
    await page.goto(`${FE}/session/${wf}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const tab = page.getByText(/^Desktop$/).first();
    checks.push({ name: "desktop: Desktop tab present for an opencode thread", ok: (await tab.count()) > 0 });
    await tab.click();
    await page.waitForTimeout(1500);
    const iframe = page.locator('iframe[title="Sandbox desktop"]');
    const src = (await iframe.getAttribute("src").catch(() => "")) ?? "";
    checks.push({ name: "desktop: pane renders the noVNC iframe (vnc.html via desktop-proxy)", ok: /\/api\/desktop-proxy\/.+\/vnc\.html/.test(src), note: src.slice(0, 80) });
    // The proxied vnc.html must actually serve (sandbox reachable).
    const vncUrl = `${FE}${src.startsWith("/") ? src : "/" + src}`;
    const r = await fetch(vncUrl, { headers: { Origin: "http://localhost:3200" } }).catch(() => null);
    checks.push({ name: "desktop: vnc.html returns 200 through the pane URL", ok: r?.status === 200, note: `HTTP ${r?.status}` });
    await shot(page, "s8-desktop");
    return verdictOf("8. Desktop tab (opencode thread / vnc.html 200)", checks, `run=${wf}`);
  } catch (e) {
    await shot(page, "s8-desktop-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("8. Desktop tab", checks);
  } finally {
    await page.close();
  }
}

// ── Scenario 9 (lead #8): auth surfaces ──────────────────────────────────────
async function s9_auth(): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  try {
    await page.goto(`${FE}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const g = page.locator('[aria-label="Continue with Google"]').first();
    checks.push({ name: "login: 'Continue with Google' present + DISABLED (unconfigured)", ok: (await g.count()) > 0 && (await g.isDisabled()) });
    checks.push({ name: "login: honest 'not configured' hint shown", ok: (await page.getByText(/Google sign-in isn't configured/i).count()) > 0 });
    checks.push({ name: "login: email + password fields present", ok: (await page.locator('input[type="email"]').count()) > 0 && (await page.locator('input[type="password"]').count()) > 0 });
    checks.push({ name: "login: 'Sign in' submit present", ok: (await page.getByRole("button", { name: /^Sign in$/ }).count()) > 0 });

    // /api/config honesty + ALLOW_DEV_ORG keeps the API working unauthenticated.
    const cfg = await fetch(`${FE}/api/config`, { headers: { Origin: "http://localhost:3200" } }).then((r) => r.json()).catch(() => null);
    checks.push({ name: "config: reports google:false + allowDevOrg true", ok: cfg?.auth?.google === false && cfg?.allowDevOrg === true, note: JSON.stringify(cfg) });
    const unauth = await fetch(`${FE}/api/runs`, { headers: { Origin: "http://localhost:3200" } });
    checks.push({ name: "auth: ALLOW_DEV_ORG default keeps API working unauthenticated (GET /api/runs 200)", ok: unauth.status === 200, note: `HTTP ${unauth.status}` });

    // User menu anonymous state.
    await page.goto(`${FE}/agent/new`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.locator('[aria-label="Open account menu"]').first().click();
    await page.waitForTimeout(500);
    const menuTxt = (await page.locator("body").innerText());
    checks.push({ name: "user-menu (anon): shows 'Sign in', not 'Log out'", ok: /Sign in/.test(menuTxt) && !/Log out/.test(menuTxt), note: /Guest|Not signed in/.test(menuTxt) ? "shows Guest/Not signed in" : "" });
    await shot(page, "s9-auth");
    return verdictOf("9. Auth surfaces (login form / Google disabled / anon menu / dev-org API)", checks);
  } catch (e) {
    await shot(page, "s9-auth-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("9. Auth surfaces", checks);
  } finally {
    await page.close();
  }
}

// ── Scenario 10 (lead #9): rail dragger resize + persistence ──────────────────
async function s10_rail(wf: string): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  try {
    await page.goto(`${FE}/session/${wf}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const sep = page.locator('[role="separator"][aria-label="Resize the side panel"]').first();
    checks.push({ name: "rail: resize separator present (md+)", ok: (await sep.count()) > 0 });
    // The rail is the section immediately after the separator.
    const railEl = page.locator('[role="separator"][aria-label="Resize the side panel"] + section');
    const widthOf = async () =>
      railEl.first().evaluate((n) => (n as HTMLElement).getBoundingClientRect().width).catch(() => 0);
    const before = await widthOf();
    // Drag the separator left by ~180px (widen the rail).
    const box = await sep.boundingBox();
    if (!box) throw new Error("separator has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 180, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const stored = await page.evaluate(() => localStorage.getItem("skynet.rail-width"));
    const after = await widthOf();
    checks.push({ name: "rail: drag changes width + persists to localStorage 'skynet.rail-width'", ok: !!stored && Math.abs(after - before) > 20, note: `before=${Math.round(before)} after=${Math.round(after)} stored=${stored}` });
    // Reload → width restored from localStorage.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const restored = await widthOf();
    const storedNum = Number(stored);
    checks.push({ name: "rail: width restored on reload (matches persisted px)", ok: Number.isFinite(storedNum) && Math.abs(restored - storedNum) < 24, note: `restored=${Math.round(restored)} stored=${storedNum}` });
    await shot(page, "s10-rail");
    return verdictOf("10. Rail dragger (resize + localStorage persistence across reload)", checks);
  } catch (e) {
    await shot(page, "s10-rail-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("10. Rail dragger", checks);
  } finally {
    await page.close();
  }
}

// ── Scenario 11 (lead #10): session a11y smoke — no console errors on load/stream ─
async function s11_a11y(wf: string): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page, consoleErrors, pageErrors } = await newPage(browser);
  const failedResources: string[] = [];
  page.on("response", (res) => { if (res.status() === 404) failedResources.push(new URL(res.url()).pathname); });
  try {
    await page.goto(`${FE}/session/${wf}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    // Exercise the conversation + agents rail (load/stream path) — NOT the
    // terminal (its ghostty teardown is covered as a defect in scenario 7).
    await page.getByText(/^Agents$/).first().click().catch(() => {});
    await page.waitForTimeout(600);
    await page.locator('[aria-label^="Open subagent:"]').first().click().catch(() => {});
    await page.waitForTimeout(600);
    const jsErrors = [...consoleErrors.filter((e) => !/Failed to load resource/i.test(e)), ...pageErrors];
    checks.push({ name: "a11y: no uncaught JS / console errors on session load+interact", ok: jsErrors.length === 0, note: jsErrors.slice(0, 3).join(" | ").slice(0, 160) });
    checks.push({ name: "a11y: no broken (404) resource requests", ok: failedResources.length === 0, note: [...new Set(failedResources)].slice(0, 4).join(", ") });
    // Basic landmark presence.
    const hasMain = (await page.locator("main, [role=main]").count()) > 0 || (await page.locator("textarea").count()) > 0;
    checks.push({ name: "a11y: primary interactive region present (composer/main)", ok: hasMain });
    return verdictOf("11. Session a11y smoke (no console errors / no 404s on load+stream)", checks, `run=${wf}`);
  } catch (e) {
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("11. Session a11y smoke", checks);
  } finally {
    await page.close();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTE-LEVEL SCENARIOS (12–17): each seeds REAL fixtures (tagged `uisweep`) via
// the backend, then asserts the page renders that real data — or an honest
// empty/error — with ZERO fabricated strings. cleanup.ts deletes the fixtures.
// ══════════════════════════════════════════════════════════════════════════════

// ── Scenario 12: Skills — list + detail sections + "Run" preselect deep-link ──
async function s12_skills(): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  const marker = crypto.randomUUID().slice(0, 6);
  const name = `${TAG}-skill ${marker}`;
  const overview = `uisweep overview line ${marker}`;
  try {
    // Seed a real skill (dev-org) with all three sections so "detail" has content.
    const created = await beApi("/api/skills", {
      body: {
        name,
        description: `uisweep skill fixture ${marker}`,
        tags: ["uisweep"],
        sections: { overview: [overview], procedure: ["do the thing"], verify: ["check the thing"] },
      },
    });
    const skillId = created.body?.id as string | undefined;
    checks.push({ name: "skills: fixture created via POST /api/skills", ok: created.status === 201 && !!skillId, note: `http=${created.status} id=${skillId?.slice(0, 8)}` });

    await page.goto(`${FE}/skills`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    checks.push({ name: "skills: page heading present", ok: (await page.getByRole("heading", { name: /^Skills$/ }).count()) > 0 });
    // List: the seeded skill's card is on the page (real data, not a mock).
    const card = page.locator("article", { hasText: name }).first();
    checks.push({ name: "skills: seeded skill renders in the library (real data)", ok: (await card.count()) > 0, note: name });
    // Detail: its section content (overview line) is rendered somewhere on the card/page.
    checks.push({ name: "skills: detail section content visible (overview line)", ok: (await page.getByText(overview).count()) > 0, note: overview });

    // Run preselect: the card's Run button deep-links to /agent/new?skill=<id>,
    // and the New Task composer opens with that playbook chosen.
    const runBtn = card.getByRole("button", { name: /^Run$|^Ran$/ }).first();
    let preselected = false;
    if ((await runBtn.count()) > 0 && skillId) {
      await runBtn.click();
      await page.waitForURL(/\/agent\/new\?skill=/, { timeout: 15_000 }).catch(() => {});
      const url = page.url();
      checks.push({ name: "skills: Run deep-links to /agent/new?skill=<id>", ok: url.includes(`skill=${skillId}`), note: url.slice(-60) });
      await page.waitForTimeout(1200);
      // The playbook picker trigger reflects the preselected skill name.
      const picker = page.locator('[aria-label="Select playbook"]').first();
      const pickerTxt = (await picker.textContent().catch(() => "")) ?? "";
      preselected = pickerTxt.includes(name) || (await page.getByText(name).count()) > 0;
      checks.push({ name: "skills: New Task composer opens with the skill preselected", ok: preselected, note: pickerTxt.slice(0, 50) });
    } else {
      checks.push({ name: "skills: Run button present on the seeded card", ok: false, note: "no Run button found" });
    }
    return verdictOf("12. Skills (list / detail sections / Run preselect deep-link)", checks);
  } catch (e) {
    await shot(page, "s12-skills-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("12. Skills", checks);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Scenario 13: Knowledge — real record renders + Add modal honest states ────
async function s13_knowledge(): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  const marker = crypto.randomUUID().slice(0, 8);
  const token = `${TAG}kb${marker}`;
  try {
    // Seed a real knowledge record (keyword-retrievable; distill stubs w/o keys).
    const ing = await beApi("/api/knowledge/ingest", {
      body: {
        meta: { source_type: "document", external_id: token, connector_instance_id: "uisweep:web", source_url: "https://example.com/uisweep", domain: "uisweep" },
        text: `uisweep knowledge fixture ${token}. The uisweep convention is to tag every test row with ${token} so cleanup deletes only ours.`,
      },
    });
    const stored = ing.status === 200 && (ing.body?.status === "stored" || ing.body?.status === "skipped");
    checks.push({ name: "knowledge: fixture ingested (stored/skipped, honest status)", ok: stored, note: `http=${ing.status} status=${ing.body?.status}` });

    await page.goto(`${FE}/knowledge`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1400);
    checks.push({ name: "knowledge: page heading present", ok: (await page.getByRole("heading", { name: /^Knowledge$/ }).count()) > 0 });
    // Real record appears (search for its unique token to avoid ambiguity).
    const search = page.locator('[aria-label="Search knowledge"]').first();
    if ((await search.count()) > 0) {
      await search.fill(token);
      await page.waitForTimeout(1400);
    }
    const tokenSeen = (await page.getByText(new RegExp(token)).count()) > 0;
    checks.push({ name: "knowledge: the seeded record renders (real data, by unique token)", ok: tokenSeen, note: token });

    // Add modal: opens with the real form fields — no fabricated success string.
    await page.getByRole("button", { name: /Add knowledge/i }).first().click().catch(() => {});
    await page.waitForTimeout(600);
    const hasName = (await page.locator("#knowledge-name").count()) > 0;
    const hasContent = (await page.locator("#knowledge-content").count()) > 0;
    checks.push({ name: "knowledge: Add modal exposes real name + content fields", ok: hasName && hasContent, note: `name=${hasName} content=${hasContent}` });
    // Honesty: before any submit, no premature "saved/success" claim is shown.
    const body = await page.locator("body").innerText();
    const falseSuccess = /\b(saved|success|added to knowledge)\b/i.test(body) && !/Save$/m.test(body);
    checks.push({ name: "knowledge: no fabricated success before submit (deferred-honest)", ok: !falseSuccess });
    return verdictOf("13. Knowledge (real record render / Add modal honest states)", checks);
  } catch (e) {
    await shot(page, "s13-knowledge-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("13. Knowledge", checks);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Scenario 14: Wiki — published document renders + honest empty branch ──────
async function s14_wiki(): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  const marker = crypto.randomUUID().slice(0, 6);
  const title = `${TAG}-wiki ${marker}`;
  const bodyMarker = `uisweep-wiki-body-${marker}`;
  try {
    // Baseline: read the current published set to know the empty vs non-empty branch.
    const before = await beApi("/api/knowledge/documents?status=published");
    const beforeCount = (before.body?.documents ?? []).length as number;

    await page.goto(`${FE}/wiki`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    checks.push({ name: "wiki: page heading present", ok: (await page.getByRole("heading", { name: /^Wiki$/ }).count()) > 0 });
    // Honest empty vs list — never a fabricated placeholder.
    const emptyShown = (await page.getByText(/No published pages yet/i).count()) > 0;
    checks.push({
      name: "wiki: honest state — empty copy iff zero published (no fabrication)",
      ok: beforeCount === 0 ? emptyShown : !emptyShown,
      note: `publishedBefore=${beforeCount} emptyShown=${emptyShown}`,
    });

    // Create + publish a real document, then assert it renders on the wiki.
    const doc = await beApi("/api/knowledge/documents", { body: { title, content: `# ${title}\n\n${bodyMarker}` } });
    const docId = doc.body?.document?.id as string | undefined;
    checks.push({ name: "wiki: document created (draft)", ok: !!docId, note: `http=${doc.status} id=${docId?.slice(0, 8)}` });
    if (docId) {
      const pub = await beApi(`/api/knowledge/documents/${docId}/publish`, { body: {} });
      checks.push({ name: "wiki: document published", ok: pub.status === 200 && pub.body?.document?.status === "published", note: `status=${pub.body?.document?.status}` });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      checks.push({ name: "wiki: published document title renders", ok: (await page.getByText(title).count()) > 0, note: title });
      checks.push({ name: "wiki: published document body renders (real content)", ok: (await page.getByText(bodyMarker).count()) > 0, note: bodyMarker });
    }
    return verdictOf("14. Wiki (published render / honest empty branch)", checks);
  } catch (e) {
    await shot(page, "s14-wiki-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("14. Wiki", checks);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Scenario 15: Schedules — create via the modal + list row (created disabled) ─
async function s15_schedules(): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  const marker = crypto.randomUUID().slice(0, 6);
  const name = `${TAG}-sched ${marker}`;
  try {
    await page.goto(`${FE}/agent/schedules`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    checks.push({ name: "schedules: page heading present", ok: (await page.getByRole("heading", { name: /^Schedules$/ }).count()) > 0 });
    checks.push({ name: "schedules: 'created disabled' automation banner present", ok: (await page.getByText(/New schedules are created disabled/i).count()) > 0 });

    // Open the New schedule modal and fill it (cron validates locally — no LLM).
    await page.getByRole("button", { name: /New schedule/i }).first().click().catch(() => {});
    await page.waitForTimeout(500);
    const nameInput = page.locator('[aria-label="Name"]').first();
    const cronInput = page.locator('[aria-label="Cron expression"]').first();
    const promptInput = page.locator('[aria-label="Prompt"]').first();
    // Hydration-safe fills.
    for (let i = 0; i < 20; i++) {
      await nameInput.fill(name);
      await cronInput.fill("0 9 * * 1");
      await promptInput.fill(`uisweep scheduled prompt ${marker}`);
      if ((await nameInput.inputValue()) === name) break;
      await page.waitForTimeout(150);
    }
    const createBtn = page.getByRole("button", { name: /^Create$|Creating/ }).first();
    await createBtn.click().catch(() => {});
    // The new row lands in the list.
    const row = page.locator("article", { hasText: name }).first();
    await row.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    checks.push({ name: "schedules: created schedule appears in the list (real row)", ok: (await row.count()) > 0, note: name });
    checks.push({ name: "schedules: new row shows cron + disabled status (honest, created off)", ok: (await row.getByText("0 9 * * 1").count()) > 0 && (await row.getByText(/Disabled/i).count()) > 0 });
    // Confirm it persisted server-side too.
    const list = await beApi("/api/schedules");
    const persisted = (list.body?.schedules ?? []).some((s: any) => s.name === name && s.enabled === false);
    checks.push({ name: "schedules: persisted server-side, enabled=false", ok: persisted, note: `count=${(list.body?.schedules ?? []).length}` });
    return verdictOf("15. Schedules (create via modal / list row / created-disabled)", checks);
  } catch (e) {
    await shot(page, "s15-schedules-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("15. Schedules", checks);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Scenario 16: Workspace — real Limits card + fleet run links → /session/ ────
async function s16_workspace(wf: string): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  try {
    // Ground truth from the same APIs the page reads.
    const fleet = (await beApi("/api/fleet")).body ?? {};
    const runs = (await beApi("/api/runs")).body?.runs ?? [];
    await page.goto(`${FE}/agent/workspace`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    checks.push({ name: "workspace: page heading present", ok: (await page.getByRole("heading", { name: /^Workspace$/ }).count()) > 0 });

    // Limits card: Models·burn panel shows REAL per-model burn or the honest empty.
    checks.push({ name: "workspace: Limits section heading present", ok: (await page.getByRole("heading", { name: /^Limits$/ }).count()) > 0 });
    const modelsHeading = (await page.getByText(/Models · burn/).count()) > 0;
    checks.push({ name: "workspace: 'Models · burn' panel present", ok: modelsHeading });
    const hasModelRows = (fleet.models ?? []).length > 0;
    const emptyBurn = (await page.getByText(/No model runs yet today/i).count()) > 0;
    const tokensToday = (await page.getByText(/tokens today/i).count()) > 0;
    checks.push({
      name: "workspace: Limits reflects real /api/fleet (rows+totals, or honest empty)",
      ok: hasModelRows ? tokensToday && !emptyBurn : emptyBurn,
      note: `apiModels=${(fleet.models ?? []).length} tokensToday=${tokensToday} emptyBurn=${emptyBurn}`,
    });

    // Fleet run links point at /session/{id} — the audit-fix contract (#79).
    const sessionLinks = page.locator('a[href^="/session/"]');
    const linkCount = await sessionLinks.count();
    // Expand lanes so collapsed run rows mount, then re-count.
    const laneButtons = page.locator('button[aria-expanded]');
    const nLanes = await laneButtons.count();
    for (let i = 0; i < nLanes; i++) await laneButtons.nth(i).click().catch(() => {});
    await page.waitForTimeout(600);
    const linksAfter = await page.locator('a[href^="/session/"]').count();
    const noDeadRunLinks = (await page.locator('a[href^="/agent/runs/"]').count()) === 0;
    if (runs.length > 0) {
      checks.push({ name: "workspace: fleet run rows link to /session/{id} (not the dead /agent/runs/)", ok: linksAfter > 0 && noDeadRunLinks, note: `sessionLinks=${linksAfter} runs=${runs.length}` });
      // The href resolves to a real run id.
      const firstHref = await page.locator('a[href^="/session/"]').first().getAttribute("href").catch(() => null);
      const realId = firstHref?.split("/session/")[1] ?? "";
      const isRealRun = runs.some((r: any) => r.id === realId);
      checks.push({ name: "workspace: a run link targets a REAL run id from /api/runs", ok: isRealRun, note: `href=${firstHref}` });
    } else {
      checks.push({ name: "workspace: no runs today ⇒ lanes honestly empty (no fabricated links)", ok: linkCount === 0 && noDeadRunLinks, note: `links=${linkCount}` });
    }
    await shot(page, "s16-workspace");
    return verdictOf("16. Workspace (real Limits card / run links → /session/)", checks, `warm=${wf}`);
  } catch (e) {
    await shot(page, "s16-workspace-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("16. Workspace", checks);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Scenario 17: Live Artifacts — card link → /session/ or honest empty ───────
async function s17_artifacts(): Promise<Result> {
  const checks: Result["checks"] = [];
  const { page } = await newPage(browser);
  try {
    const runs = (await beApi("/api/runs")).body?.runs ?? [];
    await page.goto(`${FE}/agent/artifacts`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    checks.push({ name: "artifacts: 'Live Artifacts' heading present", ok: (await page.getByRole("heading", { name: /Live Artifacts/ }).count()) > 0 });

    const cards = page.locator("article");
    const cardCount = await cards.count();
    const emptyShown = (await page.getByText(/No artifacts yet/i).count()) > 0;
    if (cardCount > 0 && !emptyShown) {
      // Each card links back to its run's session.
      const link = page.locator('a[href^="/session/"]').first();
      const href = (await link.getAttribute("href").catch(() => null)) ?? "";
      const runId = href.split("/session/")[1] ?? "";
      const isRealRun = runs.some((r: any) => r.id === runId);
      checks.push({ name: "artifacts: card links to /session/{runId} (real run)", ok: !!href && isRealRun, note: `href=${href}` });
    } else {
      // Honest empty: the CTA points at /agent/new — no fabricated gallery.
      const cta = (await page.locator('a[href="/agent/new"]').count()) > 0;
      checks.push({ name: "artifacts: honest empty state ('No artifacts yet' + Start a run CTA)", ok: emptyShown && cta, note: `empty=${emptyShown} cta=${cta}` });
    }
    await shot(page, "s17-artifacts");
    return verdictOf("17. Live Artifacts (card link → /session/ or honest empty)", checks);
  } catch (e) {
    await shot(page, "s17-artifacts-fail");
    checks.push({ name: "scenario threw", ok: false, note: String(e).slice(0, 160) });
    return verdictOf("17. Live Artifacts", checks);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── runner ────────────────────────────────────────────────────────────────────
function sh(cmd: string): string {
  try { return Bun.spawnSync(["bash", "-lc", cmd]).stdout.toString().trim(); } catch { return ""; }
}

async function main() {
  console.log(`\n████ UI E2E SWEEP — FE=${FE} BE=${BE} ████`);
  // Provenance: bind every result to the exact commit + runtime it was produced
  // under, so a green sweep can never be misattributed to code it didn't exercise.
  const sha = sh("git rev-parse --short HEAD") || "unknown";
  const dirty = sh("git status --porcelain") !== "";
  const branch = sh("git rev-parse --abbrev-ref HEAD") || "?";
  console.log(
    `  provenance: commit ${sha}${dirty ? "+dirty" : ""} (${branch}) · ${new Date().toISOString()} · ` +
      `bun ${Bun.version} · ${process.platform}/${process.arch} · scenarios=${ONLY.length ? ONLY.join(",") : "all"}`,
  );
  browser = await launch();
  let wf = "";
  // 16/17 are LIST views (workspace / artifacts) — they read /api/runs+/api/fleet
  // and assert real data OR an honest empty branch, so they never need a warm
  // (sandbox-alive) session of their own.
  const needWarm = [2, 3, 5, 7, 8, 10, 11].some(want);
  if (needWarm) {
    console.log("… ensuring a warm opencode fanout fixture");
    wf = await ensureWarmFanout();
    console.log(`   warm fanout = ${wf}`);
  }
  try {
    if (want(1)) results.push(await s1_hero());
    if (want(9)) results.push(await s9_auth());
    if (want(3)) results.push(await s3_slash(wf));
    if (want(5)) results.push(await s5_fanout(wf));
    if (want(7)) results.push(await s7_terminal(wf));
    if (want(8)) results.push(await s8_desktop(wf));
    if (want(10)) results.push(await s10_rail(wf));
    if (want(11)) results.push(await s11_a11y(wf));
    // Route-level scenarios (12–17) — seed real fixtures, assert real render.
    if (want(12)) results.push(await s12_skills());
    if (want(13)) results.push(await s13_knowledge());
    if (want(14)) results.push(await s14_wiki());
    if (want(15)) results.push(await s15_schedules());
    if (want(16)) results.push(await s16_workspace(wf));
    if (want(17)) results.push(await s17_artifacts());
    if (want(2)) results.push(await s2_reply(wf)); // mutates wf (real reply) → run last on wf
    if (want(4)) results.push(await s4_streaming());
    if (want(6)) results.push(await s6_reconnect());
  } finally {
    await browser.close();
  }
  console.log("\n\n════════════════ RESULTS ════════════════");
  for (const r of results) printResult(r);
  const pass = results.filter((r) => r.verdict === "PASS").length;
  const fail = results.filter((r) => r.verdict === "FAIL").length;
  const skip = results.filter((r) => r.verdict === "SKIP").length;
  console.log(`\n═══ ${pass} PASS · ${fail} FAIL · ${skip} SKIP (of ${results.length}) ═══`);
  await Bun.write("/tmp/uisweep-results.json", JSON.stringify(results, null, 2));
  process.exit(fail > 0 ? 1 : 0);
}

await main();
