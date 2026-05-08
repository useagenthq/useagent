/**
 * Phase 0 DOM render gate (final_harness.md): protect the OpenCode /session render
 * before any canonical/React rewiring. Opens a REAL settled OpenCode session in a
 * headless browser and asserts it renders - no uncaught crash, non-blank timeline,
 * within a time budget (guards the 3-4min freeze / blank / crash regressions we hit).
 * Structural assertions only - no customer content is asserted or committed.
 *
 * Run:  FE_ORIGIN=http://localhost:3401 BE_ORIGIN=http://localhost:3501 \
 *       RUN_ID=<settled-opencode-run> bun test/e2e/phase0-render.ts
 */
import { FE, launch, newPage, printResult, shot, verdictOf } from "./ui-sweep/harness";

const RUN_ID = process.env.RUN_ID;
if (!RUN_ID) throw new Error("set RUN_ID to a settled OpenCode run id");

const BUDGET_MS = Number(process.env.RENDER_BUDGET_MS ?? 20_000);

const browser = await launch();
try {
  const { page, consoleErrors, pageErrors } = await newPage(browser);
  const t0 = performance.now();
  await page.goto(`${FE}/session/${RUN_ID}`, { waitUntil: "domcontentloaded", timeout: BUDGET_MS });
  // Wait for the timeline to actually paint content (not just an empty shell).
  await page
    .waitForFunction(() => (document.body?.innerText?.length ?? 0) > 200, { timeout: BUDGET_MS })
    .catch(() => {});
  const readyMs = performance.now() - t0;

  const bodyLen = await page.evaluate(() => document.body?.innerText?.length ?? 0);
  // A hard React crash blanks to a tiny error page; catch that + any uncaught error.
  const crashed = pageErrors.some((e) => /Minified React error|Maximum update depth|is not a function/.test(e));
  await shot(page, `phase0-render-${RUN_ID.slice(0, 8)}`);

  const checks = [
    { name: "no uncaught page errors", ok: pageErrors.length === 0, note: pageErrors.slice(0, 2).join(" | ") },
    { name: "no React crash signature", ok: !crashed },
    { name: "timeline rendered (non-blank, >200 chars)", ok: bodyLen > 200, note: `${bodyLen} chars` },
    { name: `usable within budget (${BUDGET_MS}ms)`, ok: readyMs < BUDGET_MS, note: `${Math.round(readyMs)}ms` },
  ];
  printResult(verdictOf(`phase0 OpenCode /session render (${RUN_ID.slice(0, 8)})`, checks));
  const failed = checks.some((c) => !c.ok);
  process.exit(failed ? 1 : 0);
} finally {
  await browser.close();
}
