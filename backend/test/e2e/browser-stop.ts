/**
 * REAL browser "interrupt active tool via the UI" proof (directive Objective B).
 *
 * Not an API cancel: this clicks the actual composer Stop control (aria-label
 * "Stop this run") while a tool step is genuinely RUNNING, then asserts the run
 * settles durably as "Stopped by user" and the UI reflects the stop (the Stop
 * control goes away, no duplicate/blank rows). Engine-parameterized so the same
 * flow proves the shared Stop path for opencode AND the ACP engines.
 *
 * Run (from backend/):
 *   FE_ORIGIN=http://localhost:3461 BE_ORIGIN=http://localhost:3501 \
 *     E2E_ENGINE=opencode bun test/e2e/browser-stop.ts
 */
import type { Browser, Page } from "playwright-core";
import { BE, FE, createRun, getRun, waitRun, newPage, launch, shot, sleep } from "./ui-sweep/harness";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL } from "../../src/runs/model-policy";

const ENGINE = process.env.E2E_ENGINE ?? "opencode";
const MODEL = process.env.E2E_MODEL ?? (ENGINE === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL);
const RUN_BUDGET_MS = Number(process.env.E2E_TERMINAL_MS ?? (ENGINE === "opencode" ? 180_000 : 360_000));
const LONG_PROMPT =
  "Use the shell/execute tool to run EXACTLY this one command and WAIT for it to fully finish before you reply: " +
  "`sleep 90`. Do NOT run any other command and do NOT reply until it has completed.";

const checks: { name: string; ok: boolean; note?: string }[] = [];
const ok = (name: string, cond: boolean, note = "") => { checks.push({ name, ok: cond, note }); console.log(`  ${cond ? "OK " : "XX "} ${name}${note ? ` — ${note}` : ""}`); };
const runIds = (page: Page) => page.$$eval("[data-run-id]", (els) => els.map((e) => (e as HTMLElement).getAttribute("data-run-id") ?? ""));

async function main() {
  console.log(`[browser-stop] FE=${FE} BE=${BE} engine=${ENGINE} model=${MODEL}`);
  const browser: Browser = await launch();
  let runId = "";
  try {
    const created = await createRun(LONG_PROMPT, { engine: ENGINE, model: MODEL });
    ok(`POST /api/runs (${ENGINE}) accepted`, created.status === 201 || created.status === 200, `status ${created.status}`);
    runId = created.id ?? "";
    if (!runId) throw new Error(`no run id: ${JSON.stringify(created.body)}`);

    const { page, consoleErrors, pageErrors } = await newPage(browser);
    await page.goto(`${FE}/session/${runId}`, { waitUntil: "domcontentloaded" });
    ok("session page opened", true, `${FE}/session/${runId}`);

    // Wait until a real tool step is RUNNING server-side (genuinely mid-flight, not
    // the boot marker) - the same signal the API cancel proof uses.
    let midflight = false;
    const startWait = Date.now();
    for (let i = 0; i < Math.ceil(RUN_BUDGET_MS / 1000); i++) {
      const r = await getRun(runId);
      const steps = (r?.steps as { kind?: string }[]) ?? [];
      if (r?.status === "running" && steps.some((s) => s.kind === "command")) { midflight = true; break; }
      if (r && (r.status === "completed" || r.status === "failed" || r.status === "cancelled")) break;
      await sleep(1000);
    }
    ok("a tool step is genuinely RUNNING (mid-flight)", midflight, `after ${Math.round((Date.now() - startWait) / 1000)}s`);

    // The composer Stop control must be visible (running + empty input). CLICK IT.
    const stopSel = 'button[aria-label="Stop this run"]';
    await page.waitForSelector(stopSel, { timeout: 20_000 });
    ok("UI Stop control is present while the run is active", true);
    await shot(page, `stop-${ENGINE}-1-before`);
    const cancelAt = Date.now();
    await page.click(stopSel);
    ok("clicked the UI Stop control", true);

    // The run must settle durably as "Stopped by user".
    const settled = await waitRun(runId, (r) => r.status === "completed" || r.status === "failed" || r.status === "cancelled", 60_000).catch(() => null);
    const stopLatency = Math.round((Date.now() - cancelAt) / 1000);
    ok("run settled after the UI Stop", !!settled, settled ? `status ${settled.status} in ${stopLatency}s` : "timed out");
    ok('durable summary is "Stopped by user"', settled?.summary === "Stopped by user", `summary "${String(settled?.summary).slice(0, 40)}"`);
    ok("stopped well before the ~90s task (genuinely interrupted)", stopLatency < 45, `${stopLatency}s`);

    // UI reflects the stop: give the stream a moment, then the Stop control is gone
    // (no longer running) and the timeline is intact (one run, not blank, no dupes).
    await sleep(3000);
    const stopStillThere = await page.$(stopSel);
    ok("UI Stop control disappears after the run stops", !stopStillThere);
    const ids = await runIds(page);
    ok("timeline still shows the run (not blank, no dupes)", ids.includes(runId) && new Set(ids).size === ids.length, `ids ${JSON.stringify(ids)}`);
    await shot(page, `stop-${ENGINE}-2-after`);

    const benign = (e: string) => /favicon|ResizeObserver|Download the React DevTools|hydrat|Failed to load resource/i.test(e);
    const realErrors = [...consoleErrors, ...pageErrors].filter((e) => !benign(e));
    ok("no console/page errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
    await page.close();
  } finally {
    if (runId) await fetch(`${BE}/api/runs/${runId}`, { method: "DELETE", headers: { Origin: "http://localhost:3200" } }).catch(() => {});
    await browser.close().catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[browser-stop] ${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(JSON.stringify({ runId, engine: ENGINE, verdict: failed.length === 0 ? "PASS" : "FAIL", failed: failed.map((c) => c.name) }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
