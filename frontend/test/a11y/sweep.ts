// Accessibility audit of the five main pages, driven the way the product runs:
// a real browser (playwright-core, system Chrome) against the real frontend
// with the real backend behind it - no app code mocked, only fixtures seeded
// through the backend's own API (mock engine thread, a bot, two tasks) the
// way test/e2e/ui-sweep seeds its rows.
//
// What it audits (issue "Accessibility audit of the five main pages"): home
// (new thread), a thread, Settings, Bots (with its New-bot dialog open, so
// modal rules like focus order run), Tasks - with @axe-core/playwright, WCAG
// 2.0/2.1/2.2 A+AA rules. Serious and critical violations FAIL the sweep
// (A11Y_GATE=report to only report them); moderate/minor are printed so they
// stay visible without gating.
//
// Stack to point it at (isolated - never a shared dev server):
//   cd backend && PORT=3611 DATABASE_URL=... USEAGENT_DEV_MODE=1 ALLOW_DEV_ORG=1
//     MEMORY_API_URL="" WORKER_STEP_DELAY_MS=1 FRONTEND_ORIGIN=http://localhost:3620 bun src/index.ts
//   cd frontend && USEAGENT_API_ORIGIN=http://localhost:3611 bun run build
//     && USEAGENT_API_ORIGIN=http://localhost:3611 bunx next start -p 3620
//   bun test/a11y/sweep.ts            (FE_ORIGIN/BE_ORIGIN env to override)
//
// The browser signs in the way the perf scripts do: a better-auth.session_token
// cookie whose value does not matter (proxy.ts checks presence; a backend with
// ALLOW_DEV_ORG=1 resolves the anonymous caller to the dev org).
import { AxeBuilder } from "@axe-core/playwright";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const FE = process.env.FE_ORIGIN ?? "http://localhost:3620";
const BE = process.env.BE_ORIGIN ?? "http://localhost:3611";
const OUT = process.env.A11Y_REPORT_DIR ?? "/tmp/a11y-report/";
/** Report-only mode: print everything but always exit 0 (baseline captures). */
const GATE = (process.env.A11Y_GATE ?? "gate") === "gate";
/** Impact levels that fail the sweep. */
const GATE_IMPACT = new Set(["critical", "serious"]);
const TAG = "a11ysweep";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

interface ViolationEntry {
  page: string;
  rule: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  nodes: string[];
}
interface PageReport {
  page: string;
  url: string;
  violations: ViolationEntry[];
  passes: number;
  incomplete: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function provenance(): string {
  const sha = (() => {
    try {
      return execSync("git rev-parse --short HEAD", { cwd: import.meta.dir }).toString().trim();
    } catch {
      return "unknown";
    }
  })();
  const dirty = (() => {
    try {
      return execSync("git status --porcelain", { cwd: import.meta.dir })
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean).length > 0
        ? "dirty"
        : "clean";
    } catch {
      return "unknown";
    }
  })();
  return `a11y sweep @ ${sha} ${dirty} | ${new Date().toISOString()} | bun ${Bun.version} | FE=${FE} BE=${BE} gate=${GATE ? "serious+critical" : "report"}`;
}

type Json = Record<string, unknown>;

/** JSON call to the backend (anonymous = dev org under ALLOW_DEV_ORG=1). */
async function beApi(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${BE}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", Origin: "http://localhost:3200" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  return { status: res.status, body };
}

/** Create a mock-engine run and wait for it to settle (WORKER_STEP_DELAY_MS=1
 *  on the backend makes the scripted trace settle in ~a second). */
async function seedSettledThread(prompt: string): Promise<{ id: string | null; status: number }> {
  const created = await beApi("/api/runs", {
    body: { prompt, engine: "mock", model: "claude-haiku-4-5" },
  });
  const id = typeof created.body?.id === "string" ? created.body.id : null;
  if (!id) return { id: null, status: created.status };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const run = await beApi(`/api/runs/${id}`);
    const status = typeof run.body?.status === "string" ? run.body.status : "";
    if (status === "completed" || status === "failed") break;
    await sleep(300);
  }
  return { id, status: created.status };
}

/** Launch system Chrome when present (CI ubuntu runners ship it), else the
 *  playwright-managed chromium, else A11Y_BROWSER_PATH verbatim. */
async function launchBrowser(): Promise<Browser> {
  const manual = process.env.A11Y_BROWSER_PATH;
  if (manual) return chromium.launch({ executablePath: manual, headless: true });
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}

async function newSessionPage(browser: Browser): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  // The perf scripts' sign-in: presence is what proxy.ts checks.
  await context.addCookies([
    { name: "better-auth.session_token", value: "a11y-sweep", domain: "localhost", path: "/" },
  ]);
  const page = await context.newPage();
  return { page, context };
}

/** Run axe on the page as-is. Returns violations trimmed to what we report. */
async function audit(page: Page, name: string, url: string): Promise<PageReport> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const violations: ViolationEntry[] = results.violations.map((v) => ({
    page: name,
    rule: v.id,
    impact: v.impact ?? null,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.slice(0, 12).map((n) => JSON.stringify(n.target)),
  }));
  return {
    page: name,
    url,
    violations,
    passes: results.passes.length,
    incomplete: results.incomplete.length,
  };
}

function printReport(report: PageReport): void {
  const counts = new Map<string, number>();
  for (const v of report.violations) counts.set(v.impact ?? "unknown", (counts.get(v.impact ?? "unknown") ?? 0) + 1);
  const summary = [...counts.entries()].map(([impact, n]) => `${n} ${impact}`).join(", ") || "none";
  console.log(`\n[${report.page}] ${report.url}`);
  console.log(`  axe: ${report.passes} passes, ${report.incomplete} incomplete, violations: ${summary}`);
  for (const v of report.violations) {
    const gated = v.impact && GATE_IMPACT.has(v.impact);
    console.log(`  ${gated ? "X" : "-"} ${v.impact ?? "?"} ${v.rule} - ${v.help}`);
    for (const node of v.nodes.slice(0, 3)) console.log(`      ${node}`);
    if (v.nodes.length > 3) console.log(`      +${v.nodes.length - 3} more`);
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  console.log(provenance());

  const browser = await launchBrowser();

  // ── Fixtures through the backend's own API (dev org, tagged for cleanup) ──
  const marker = crypto.randomUUID().slice(0, 6);
  const thread = await seedSettledThread(`${TAG} thread ${marker}: audit the five main pages`);
  const bot = await beApi("/api/bots", {
    body: { name: `${TAG} bot ${marker}`, title: "Accessibility audit bot", rules: "Seed row for the a11y sweep.", engine: "mock" },
  });
  const taskA = await beApi("/api/tasks", {
    body: { title: `${TAG} task ${marker}: pass the axe gate`, status: "todo" },
  });
  const taskB = await beApi("/api/tasks", {
    body: { title: `${TAG} task ${marker}: fix serious and critical findings`, status: "in_progress" },
  });
  console.log(
    `fixtures: thread=${thread.id ? thread.id.slice(0, 8) : `FAILED(http ${thread.status})`} bot=${bot.status === 201 ? "created" : `http ${bot.status}`} tasks=${taskA.status}/${taskB.status}`,
  );

  const reports: PageReport[] = [];

  // ── 1. Home (new thread) ─────────────────────────────────────────────────
  {
    const { page, context } = await newSessionPage(browser);
    await page.goto(`${FE}/agent/new`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("h1", { state: "attached", timeout: 20_000 });
    await sleep(1200); // let the recent-runs list and composer settle
    const report = await audit(page, "1. home (new thread)", page.url());
    await page.screenshot({ path: `${OUT}01-home.png`, fullPage: true }).catch(() => {});
    reports.push(report);
    printReport(report);
    await context.close();
  }

  // ── 2. A thread ──────────────────────────────────────────────────────────
  {
    const { page, context } = await newSessionPage(browser);
    if (thread.id) {
      await page.goto(`${FE}/session/${thread.id}`, { waitUntil: "domcontentloaded" });
      // The thread page streams in its timeline; wait for real content.
      await page.waitForSelector("main, [data-row-key], article", { timeout: 20_000 }).catch(() => {});
      await sleep(1500);
    } else {
      await page.goto(`${FE}/agent/new`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("h1", { state: "attached", timeout: 20_000 });
    }
    const report = await audit(page, "2. a thread", page.url());
    await page.screenshot({ path: `${OUT}02-thread.png`, fullPage: true }).catch(() => {});
    reports.push(report);
    printReport(report);
    await context.close();
  }

  // ── 3. Settings ──────────────────────────────────────────────────────────
  {
    const { page, context } = await newSessionPage(browser);
    await page.goto(`${FE}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("h1", { state: "attached", timeout: 20_000 });
    await sleep(1500); // provider/integration cards fetch on mount
    const report = await audit(page, "3. Settings", page.url());
    await page.screenshot({ path: `${OUT}03-settings.png`, fullPage: true }).catch(() => {});
    reports.push(report);
    printReport(report);
    await context.close();
  }

  // ── 4. Bots (list + the New-bot dialog open, so modal rules run) ─────────
  {
    const { page, context } = await newSessionPage(browser);
    await page.goto(`${FE}/bots`, { waitUntil: "domcontentloaded" });
    // The Bots workspace renders its h1 visually hidden in some states, so
    // wait for it to be ATTACHED, then for the roster or onboarding to paint.
    await page.waitForSelector("h1", { state: "attached", timeout: 20_000 });
    await page.waitForSelector("main, [role=grid], [role=list]", { state: "attached", timeout: 10_000 }).catch(() => {});
    await sleep(1200);
    const newBot = page.getByRole("button", { name: /new bot/i }).first();
    if ((await newBot.count()) > 0) {
      await newBot.click().catch(() => {});
      await page.waitForTimeout(800);
      const dialog = page.getByRole("dialog").first();
      if ((await dialog.count()) > 0) await sleep(400);
    }
    const report = await audit(page, "4. Bots", page.url());
    await page.screenshot({ path: `${OUT}04-bots.png`, fullPage: true }).catch(() => {});
    reports.push(report);
    printReport(report);
    await context.close();
  }

  // ── 5. Tasks ─────────────────────────────────────────────────────────────
  {
    const { page, context } = await newSessionPage(browser);
    await page.goto(`${FE}/tasks`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("h1", { state: "attached", timeout: 20_000 });
    await sleep(1200); // board fetches SSR, columns settle client-side
    const report = await audit(page, "5. Tasks", page.url());
    await page.screenshot({ path: `${OUT}05-tasks.png`, fullPage: true }).catch(() => {});
    reports.push(report);
    printReport(report);
    await context.close();
  }

  await browser.close();

  // ── Artifacts: full JSON + a readable markdown table ─────────────────────
  const allViolations = reports.flatMap((r) => r.violations);
  const gated = allViolations.filter((v) => v.impact && GATE_IMPACT.has(v.impact));
  writeFileSync(
    `${OUT}a11y-report.json`,
    JSON.stringify({ provenance: provenance(), gate: GATE ? [...GATE_IMPACT] : "report", reports }, null, 2),
  );
  const markdown = [
    `# Accessibility audit`,
    ``,
    `${provenance()}`,
    ``,
    `| page | passes | incomplete | critical | serious | moderate | minor |`,
    `| --- | --- | --- | --- | --- | --- | --- |`,
    ...reports.map((r) => {
      const c = (impact: string) => r.violations.filter((v) => v.impact === impact).length;
      return `| ${r.page} | ${r.passes} | ${r.incomplete} | ${c("critical")} | ${c("serious")} | ${c("moderate")} | ${c("minor")} |`;
    }),
    ``,
    ...allViolations.flatMap((v) => [
      `## ${v.page} - ${v.rule} (${v.impact ?? "unknown"})`,
      ``,
      `${v.help} ([rule](${v.helpUrl}))`,
      ``,
      ...v.nodes.map((n) => `- ${n}`),
      ``,
    ]),
  ].join("\n");
  writeFileSync(`${OUT}a11y-report.md`, markdown);

  console.log(`\nreport: ${OUT}a11y-report.{json,md} | screenshots: ${OUT}0*.png`);
  console.log(
    `violations: ${allViolations.length} total, ${gated.length} gated (serious+critical) across ${reports.length} pages`,
  );

  if (gated.length > 0) {
    console.log("\ngated violations by rule:");
    const byRule = new Map<string, number>();
    for (const v of gated) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
    for (const [rule, n] of byRule) console.log(`  ${rule}: ${n}`);
  }

  if (GATE && gated.length > 0) {
    console.error(`\nFAIL: ${gated.length} serious/critical violations must be fixed (A11Y_GATE=report to bypass).`);
    process.exit(1);
  }
  console.log("\nPASS: no serious or critical violations on the five pages.");
}

await main();
