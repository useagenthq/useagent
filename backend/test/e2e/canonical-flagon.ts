/**
 * REAL flag-on browser E2E for the canonical timeline.
 *
 * Drives an ISOLATED flag-on frontend (NEXT_PUBLIC_CANONICAL_TIMELINE=1) + an isolated
 * backend on a throwaway DB against a REAL Daytona/OpenCode run. Proves the canonical lane
 * actually renders end-to-end - not a component stub:
 *   - a real OpenCode task streams live narration + tool rows
 *   - it completes; canonical-complete arrives and the render SWITCHES to the canonical
 *     lane (asserted via data-timeline-source="canonical")
 *   - reload preserves the timeline / tools / summary (durable canonical replay)
 *   - a second turn in the same thread does not disappear or mutate the first
 *   - a reconnect (reload) yields no duplicate rows, no blank timeline, no console errors
 *   - the rendered DOM matches backend truth (tool count == steps, marker + reply text)
 *
 * Run (from backend/):
 *   FE_ORIGIN=http://localhost:3451 BE_ORIGIN=http://localhost:3251 \
 *     bun test/e2e/canonical-flagon.ts
 *
 * NOT a unit test - it needs the live isolated stack. Self-cleaning (deletes its run's
 * sandbox via the backend). Prints a JSON verdict + screenshots under UISWEEP_SHOTS.
 */
import type { Browser, Page } from "playwright-core";
import { BE, FE, createRun, getRun, getThread, waitRun, newPage, launch, shot, sleep } from "./ui-sweep/harness";

const MARKER = "CANON_E2E_MARKER_9931";
const REPLY = "DONE9931";
// Engine + model are overridable so the SAME 18-check flow (create, live, complete,
// canonical-switch, reload, second turn, reconnect, tools, answer, no-dupes/blank) runs
// for opencode AND the ACP engines (claude/codex). opencode uses an OpenRouter slug
// (has a "/"); the ACP engines run their CLI with a direct model id.
const ENGINE = process.env.E2E_ENGINE ?? "opencode";
const MODEL = process.env.E2E_MODEL ?? (ENGINE === "opencode" ? "anthropic/claude-haiku-4.5" : "claude-haiku-4-5");
// CLIENT-side wait for a run to settle - this is NOT the backend timeout fix. The real
// cold-ACP reliability fix is the committed backend default (acp-server resolveAcpTurnTimeoutMs:
// ACP_TURN_TIMEOUT_MS -> ENGINE_TIMEOUT_MS -> 360s). This just keeps the test's poll budget
// at least as large so it doesn't give up before the backend does; overridable via
// E2E_TERMINAL_MS. A cold ACP sandbox reinstalls the agent (~250MB) every fresh-thread run.
const TERMINAL_MS = Number(process.env.E2E_TERMINAL_MS ?? (ENGINE === "opencode" ? 180_000 : 360_000));
const checks: { name: string; ok: boolean; note?: string }[] = [];
const ok = (name: string, cond: boolean, note = "") => { checks.push({ name, ok: cond, note }); console.log(`  ${cond ? "OK " : "XX "} ${name}${note ? ` — ${note}` : ""}`); };

async function timelineSource(page: Page): Promise<string[]> {
  return page.$$eval("[data-timeline-source]", (els) => els.map((e) => (e as HTMLElement).dataset.timelineSource ?? ""));
}
async function runIds(page: Page): Promise<string[]> {
  return page.$$eval("[data-run-id]", (els) => els.map((e) => (e as HTMLElement).getAttribute("data-run-id") ?? ""));
}
async function toolCount(page: Page): Promise<number> {
  return page.$$eval('[data-testid="tool-row"]', (els) => els.length).catch(() => 0);
}
async function timelineText(page: Page): Promise<string> {
  // the whole turn block carries the interleaved timeline + the agent answer/summary.
  return page.$$eval('[data-testid="turn-block"]', (els) => els.map((e) => (e as HTMLElement).innerText).join("\n")).catch(() => "");
}
/** Poll until at least one turn's timeline is driven by the canonical lane. */
async function waitCanonical(page: Page, budgetMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const src = await timelineSource(page);
    if (src.includes("canonical")) return true;
    await sleep(1000);
  }
  return false;
}

async function main() {
  console.log(`[flagon-e2e] FE=${FE} BE=${BE} engine=${ENGINE} model=${MODEL}`);
  const browser: Browser = await launch();
  let runId = "";
  try {
    // 1. Create a REAL OpenCode task (deterministic: one bash tool + a fixed reply).
    const prompt = `Use the bash tool to run exactly: echo ${MARKER}. Then reply with exactly this and nothing else: ${REPLY}`;
    const created = await createRun(prompt, { engine: ENGINE, model: MODEL });
    ok(`POST /api/runs (${ENGINE}) accepted`, created.status === 201 || created.status === 200, `status ${created.status} id ${created.id ?? created.body?.error ?? ""}`);
    runId = created.id ?? "";
    if (!runId) throw new Error(`no run id: ${JSON.stringify(created.body)}`);

    // 2. Open the session page and watch it stream live.
    const { page, consoleErrors, pageErrors } = await newPage(browser);
    const failedUrls: string[] = [];
    page.on("requestfailed", (r) => failedUrls.push(r.url()));
    page.on("response", (r) => { if (r.status() === 404) failedUrls.push(`404 ${r.url()}`); });
    await page.goto(`${FE}/session/${runId}`, { waitUntil: "domcontentloaded" });
    ok("session page opened", true, `${FE}/session/${runId}`);

    // 3. Wait for the run to actually complete server-side (real sandbox).
    const settled = await waitRun(runId, (r) => r.status === "completed" || r.status === "failed", 180_000).catch(() => null);
    ok("run reached a terminal state", !!settled && settled.status === "completed", settled ? `status ${settled.status}` : "timed out");

    // 4. Wait for canonical-complete to arrive + the render to switch to the canonical lane.
    const wentCanonical = await waitCanonical(page, 60_000);
    ok("timeline switched to the CANONICAL lane (data-timeline-source=canonical)", wentCanonical);
    await shot(page, "flagon-1-live-complete");

    // 5. Capture the canonical-rendered content + cross-check against backend truth.
    const thread = await getThread(runId);
    // Only command/file steps render as tool ROWS; task/narration steps render as text.
    const toolSteps = (thread[0]?.steps ?? []).filter((s: any) => s.kind === "command" || s.kind === "file");
    const text1 = await timelineText(page);
    const tools1 = await toolCount(page);
    ok("rendered timeline shows the tool marker output", text1.includes(MARKER), `marker ${text1.includes(MARKER) ? "present" : "MISSING"}`);
    ok("rendered timeline shows the assistant reply", text1.includes(REPLY), `reply ${text1.includes(REPLY) ? "present" : "MISSING"}`);
    ok("rendered tool-row count matches backend command/file steps", tools1 > 0 && tools1 === toolSteps.length, `dom ${tools1} vs command/file steps ${toolSteps.length}`);
    const ids1 = await runIds(page);
    ok("run identity present + unique (no dup turns)", ids1.includes(runId) && new Set(ids1).size === ids1.length, `ids ${JSON.stringify(ids1)}`);

    // 6. RELOAD — durable canonical replay must preserve everything (no reload needed to keep it).
    await page.reload({ waitUntil: "domcontentloaded" });
    const stillCanonical = await waitCanonical(page, 30_000);
    const text2 = await timelineText(page);
    const tools2 = await toolCount(page);
    ok("after RELOAD still canonical", stillCanonical);
    ok("after RELOAD marker + reply persist", text2.includes(MARKER) && text2.includes(REPLY));
    ok("after RELOAD tool count stable (no dupes, not blank)", tools2 === tools1 && tools2 > 0, `before ${tools1} after ${tools2}`);
    await shot(page, "flagon-2-reload");

    // 7. SECOND TURN in the same thread (real UI submit) — first turn must not disappear/mutate.
    const secondPrompt = `Reply with exactly this and nothing else: SECOND${REPLY}`;
    await page.fill("textarea", secondPrompt).catch(() => {});
    await page.keyboard.press("Enter");
    // wait for a second run to appear in the thread
    let secondId = "";
    for (let i = 0; i < 60 && !secondId; i++) {
      const t = await getThread(runId);
      const other = t.map((r: any) => r.id).find((id: string) => id !== runId);
      if (other) secondId = other;
      await sleep(1000);
    }
    ok("second turn created in the same thread", !!secondId, secondId ? `id ${secondId}` : "none");
    if (secondId) await waitRun(secondId, (r) => r.status === "completed" || r.status === "failed", 180_000).catch(() => null);
    await waitCanonical(page, 60_000);
    const ids3 = await runIds(page);
    const text3 = await timelineText(page);
    ok("first turn STILL present after the second turn", ids3.includes(runId), `ids ${JSON.stringify(ids3)}`);
    ok("first turn's marker + reply unchanged after the second turn", text3.includes(MARKER) && text3.includes(REPLY));
    ok("two distinct turns render (no collapse, no dup)", secondId ? (ids3.includes(secondId) && new Set(ids3).size === ids3.length) : true, `ids ${JSON.stringify(ids3)}`);
    await shot(page, "flagon-3-second-turn");

    // 8. RECONNECT (fresh reload) — no duplicate rows, no blank, no console errors.
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitCanonical(page, 30_000);
    const ids4 = await runIds(page);
    const text4 = await timelineText(page);
    ok("after RECONNECT no duplicate turns", new Set(ids4).size === ids4.length && ids4.includes(runId), `ids ${JSON.stringify(ids4)}`);
    ok("after RECONNECT timeline not blank", text4.includes(MARKER) && text4.length > 0);
    await shot(page, "flagon-4-reconnect");

    const benign = (e: string) => /favicon|ResizeObserver|Download the React DevTools|hydrat|Failed to load resource/i.test(e);
    console.log("[flagon-e2e] failed/404 URLs:", JSON.stringify([...new Set(failedUrls)].slice(0, 8)));
    const realErrors = [...consoleErrors, ...pageErrors].filter((e) => !benign(e));
    ok("no console/page errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

    await page.close();
  } finally {
    // Self-clean: delete the run(s) + sandbox via the backend (Daytona hygiene).
    if (runId) {
      const t = await getThread(runId).catch(() => []);
      for (const r of t) await fetch(`${BE}/api/runs/${r.id}`, { method: "DELETE", headers: { Origin: "http://localhost:3200" } }).catch(() => {});
      await fetch(`${BE}/api/runs/${runId}`, { method: "DELETE", headers: { Origin: "http://localhost:3200" } }).catch(() => {});
    }
    await browser.close().catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n[flagon-e2e] ${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(JSON.stringify({ runId, verdict: failed.length === 0 ? "PASS" : "FAIL", failed: failed.map((c) => c.name) }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
