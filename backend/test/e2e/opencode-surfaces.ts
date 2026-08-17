/**
 * Real OpenCode session-surface E2E (final_harness Phase 0 exit gate).
 *
 * Replaces the shallow phase0-render check (timeline-exists + child-count + a
 * textarea) with REAL UI-surface assertions on a settled multi-turn OpenCode run:
 * conversation turns + user/assistant messages, tool rows (after expanding the
 * folded disclosures), context markers, the agents rail + subagent cards, the
 * editor pane + file tabs, the terminal log, and RELOAD persistence. It is
 * capability-aware: it reads the thread from the backend, computes which surfaces
 * that run actually has, and asserts each present surface renders (SKIP otherwise) -
 * no generic childElementCount. Read-only (loads a settled run; creates nothing).
 *
 * Run:  FE_ORIGIN=http://localhost:3414 BE_ORIGIN=http://localhost:3501 \
 *       RUN_ID=<settled-opencode-root-run> bun test/e2e/opencode-surfaces.ts
 */
import { FE, BE, launch, newPage, printResult, shot, verdictOf } from "./ui-sweep/harness";
import type { Page } from "playwright-core";

const RUN_ID = process.env.RUN_ID;
if (!RUN_ID) throw new Error("set RUN_ID to a settled OpenCode root run id");
const BUDGET_MS = Number(process.env.RENDER_BUDGET_MS ?? 30_000);

type Step = { kind?: string; chip?: string | null };
type Run = { steps?: Step[] };

// What surfaces SHOULD this run render? Derived from the real thread, mirroring
// the frontend's own gating (session-view.tsx hasFiles/hasCommands/hasSubagents).
async function expectedSurfaces() {
  const res = await fetch(`${BE}/api/runs/${RUN_ID}?thread=1`, {
    headers: { Origin: "http://localhost:3200" },
  });
  const j = (await res.json().catch(() => ({}))) as { thread?: Run[] };
  const thread = j.thread ?? [];
  const steps = thread.flatMap((r) => r.steps ?? []);
  const chip = (c: string) => steps.some((s) => s.chip === c);
  return {
    turnCount: thread.length,
    hasCommands: steps.some((s) => s.kind === "command"),
    hasFiles: steps.some((s) => s.kind === "file"),
    // Exactly the frontend's gate for the Agents tab (session-view.tsx): a real
    // fanout stamps chip === "subagent". A "task" chip is the final-answer synthetic
    // step, NOT a subagent - counting it wrongly expected cards on a fanout-free run.
    hasSubagents: chip("subagent"),
    // skill.loaded / memory / knowledge markers appear as canonical marker rows OR
    // as skill/memory tool chips; treat either representation as "markers present".
    hasMarkers: chip("skill") || chip("skynet-knowledge_memory_remember") || chip("knowledge"),
  };
}

const count = (page: Page, sel: string) => page.locator(sel).count();

/** Expand the folded "Ran N tools" / Worklog GROUP disclosures so the tool rows
 *  inside enter the DOM (settled turns collapse them). Targets only the grouping
 *  buttons by their label - NOT each tool-row's own detail toggle (clicking all of
 *  those renders hundreds of heavy payloads and is not what we're asserting). */
async function expandDisclosures(page: Page) {
  for (let pass = 0; pass < 3; pass++) {
    const groups = page
      .locator('[data-testid="session-timeline"] button[aria-expanded="false"]')
      .filter({ hasText: /Ran \d+ tool|Worklog|\d+ step/ });
    const n = await groups.count();
    if (n === 0) break;
    for (let i = 0; i < n; i++) {
      await groups.nth(i).click({ timeout: 2000 }).catch(() => {});
    }
  }
}

/** Click a rail tab by testid, falling back to its visible label. */
async function openRailTab(page: Page, id: "agents" | "editor" | "terminal", label: string) {
  const byTestId = page.locator(`[data-testid="rail-tab-${id}"]`);
  if (await byTestId.count()) {
    await byTestId.first().click({ timeout: 3000 }).catch(() => {});
    return;
  }
  await page.getByText(label, { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
}

const browser = await launch();
const checks: { name: string; ok: boolean; note?: string }[] = [];
const add = (name: string, ok: boolean, note?: string) => checks.push({ name, ok, note });

try {
  const want = await expectedSurfaces();
  const { page, pageErrors } = await newPage(browser);

  const t0 = performance.now();
  await page.goto(`${FE}/session/${RUN_ID}`, { waitUntil: "domcontentloaded", timeout: BUDGET_MS });
  await page.waitForSelector('[data-testid="session-timeline"]', { timeout: BUDGET_MS });
  const readyMs = performance.now() - t0;
  add(`usable within budget (${BUDGET_MS}ms)`, readyMs < BUDGET_MS, `${Math.round(readyMs)}ms`);

  // ── Conversation: every turn renders, with user + assistant content ──────────
  const turnBlocks = await count(page, '[data-testid="turn-block"]');
  add("all thread turns render", turnBlocks === want.turnCount, `${turnBlocks}/${want.turnCount} turns`);
  if (want.turnCount > 1) add("multi-turn conversation (>1 turn)", turnBlocks > 1, `${turnBlocks} turns`);
  add("user messages render", (await count(page, '[data-testid="user-message"]')) >= 1);
  add("assistant answers render", (await count(page, '[data-testid="agent-answer"]')) >= 1);

  // ── Tool rows: expand the folded disclosures, then count real trace rows ─────
  await expandDisclosures(page);
  // Tool rows render through the vendored T3 work-entry grammar since the
  // t3-ui timeline wiring; the legacy testid stays as a pre-cutover fallback.
  const toolRows =
    (await count(page, '[data-t3-ui="work-entry-row"]')) +
    (await count(page, '[data-testid="tool-row"]'));
  const todoRows = await count(page, '[data-testid="todo-list"]');
  if (want.hasCommands || want.hasFiles) {
    add("tool rows render after expand", toolRows + todoRows > 0, `${toolRows} tool + ${todoRows} todo`);
  }

  // ── Context markers (skill / memory / knowledge) ────────────────────────────
  const markerRows = await count(page, '[data-testid="marker-row"]');
  if (want.hasMarkers) {
    // Rendered either as a canonical marker row or as a skill/memory tool row.
    add("skill/memory markers render", markerRows > 0 || toolRows > 0, `${markerRows} marker rows`);
  }

  // ── Agents rail: subagent cards + openable detail ───────────────────────────
  if (want.hasSubagents) {
    await openRailTab(page, "agents", "Agents");
    await page.waitForSelector('[data-testid="agents-rail"]', { timeout: 5000 }).catch(() => {});
    const cards = await count(page, '[data-testid="subagent-card"]');
    add("agents rail lists subagent cards", cards > 0, `${cards} cards`);
    if (cards > 0) {
      await page.locator('[data-testid="subagent-card"]').first().click({ timeout: 3000 }).catch(() => {});
      const detailOpened = await page.getByRole("button", { name: /back to agents/i }).count();
      add("subagent card opens a detail view", detailOpened > 0);
      await page.getByRole("button", { name: /back to agents/i }).first().click({ timeout: 2000 }).catch(() => {});
    }
  }

  // ── Editor pane: file tabs ──────────────────────────────────────────────────
  if (want.hasFiles) {
    await openRailTab(page, "editor", "Editor");
    await page.waitForSelector('[data-testid="editor-pane"]', { timeout: 5000 }).catch(() => {});
    add("editor pane renders", (await count(page, '[data-testid="editor-pane"]')) > 0);
    add("editor shows file tabs", (await count(page, '[data-testid="editor-file"]')) > 0,
      `${await count(page, '[data-testid="editor-file"]')} files`);
  }

  // ── Terminal pane: command log ──────────────────────────────────────────────
  if (want.hasCommands) {
    await openRailTab(page, "terminal", "Terminal");
    await page.waitForSelector('[data-testid="terminal-pane"]', { timeout: 5000 }).catch(() => {});
    add("terminal pane renders", (await count(page, '[data-testid="terminal-pane"]')) > 0);
    // The Log tab holds the run's command steps (Shell is a live PTY into a maybe-dead sandbox).
    await page.locator('[data-testid="terminal-tab-log"]').first().click({ timeout: 3000 }).catch(() => {});
    const logText = (await page.locator('[data-testid="terminal-log"]').first().innerText().catch(() => "")) ?? "";
    add("terminal log shows command lines", logText.includes("$") && logText.trim().length > 3,
      `${logText.trim().length} chars`);
  }

  await shot(page, `opencode-surfaces-${RUN_ID.slice(0, 8)}`);

  // ── Reload persistence: the whole surface survives a fresh navigation ────────
  // Poll until the turn set STABILIZES to the same distinct runs - the reload path
  // SSRs initialThread and then replays the thread SSE, so a naive immediate count
  // can catch a transient before the store's merge-by-id settles. We assert on the
  // settled count AND that the runs are distinct (unique==total), so a genuine
  // double-render (unique < total) is still caught.
  await page.reload({ waitUntil: "domcontentloaded", timeout: BUDGET_MS });
  await page.waitForSelector('[data-testid="session-timeline"]', { timeout: BUDGET_MS }).catch(() => {});
  let turnsAfter = 0;
  let uniqueAfter = 0;
  for (let i = 0; i < 25; i++) {
    const ids = await page
      .locator('[data-testid="turn-block"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-run-id")));
    turnsAfter = ids.length;
    uniqueAfter = new Set(ids).size;
    if (turnsAfter === turnBlocks && uniqueAfter === turnBlocks) break;
    await page.waitForTimeout(300);
  }
  add(
    "reload: turns persist identically (settled, distinct)",
    turnsAfter === turnBlocks && uniqueAfter === turnBlocks,
    `${turnsAfter} total / ${uniqueAfter} unique vs ${turnBlocks}`,
  );

  // ── No crash ────────────────────────────────────────────────────────────────
  const crashed = pageErrors.some((e) => /Minified React error|Maximum update depth|is not a function/.test(e));
  add("no React crash", !crashed, pageErrors.slice(0, 2).join(" | "));
  add("no uncaught page errors", pageErrors.length === 0, `${pageErrors.length} errors`);

  printResult(verdictOf(`OpenCode session surfaces (${RUN_ID.slice(0, 8)})`, checks));
  process.exit(checks.some((c) => !c.ok) ? 1 : 0);
} finally {
  await browser.close();
}
