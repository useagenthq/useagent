/**
 * Shared harness for the aggressive browser-level UI E2E sweep.
 * Drives the isolated stack: frontend http://localhost:3413 (SKYNET_API_ORIGIN
 * → backend http://localhost:3513, real `skynet` DB, committed HEAD).
 * Playwright headless via system Chrome (channel: "chrome"). No src edits.
 */
import { chromium, type Browser, type Page } from "playwright-core";

export const FE = process.env.FE_ORIGIN ?? "http://localhost:3413";
export const BE = process.env.BE_ORIGIN ?? "http://localhost:3513";
/** Every fixture prompt carries this tag so cleanup deletes ONLY our rows. */
export const TAG = "uisweep";
/** Screenshots go to a tmp/artifact dir — never into the repo. */
export const SHOTS = process.env.UISWEEP_SHOTS ?? "/tmp/uisweep-shots/";

export type Verdict = "PASS" | "FAIL" | "SKIP";
export interface Result {
  scenario: string;
  verdict: Verdict;
  detail: string;
  checks: { name: string; ok: boolean; note?: string }[];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST /api/runs through the backend directly, dev-org via Origin :3200. */
export async function createRun(
  prompt: string,
  opts: { engine?: string; model?: string; parent_run_id?: string; idempotencyKey?: string } = {},
): Promise<{ status: number; id?: string; body: any }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    Origin: "http://localhost:3200",
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const res = await fetch(`${BE}/api/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt,
      engine: opts.engine ?? "mock",
      model: opts.model ?? "claude-haiku-4-5",
      ...(opts.parent_run_id ? { parent_run_id: opts.parent_run_id } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, id: body?.id, body };
}

export async function getRun(id: string): Promise<any> {
  const res = await fetch(`${BE}/api/runs/${id}`, { headers: { Origin: "http://localhost:3200" } });
  return res.ok ? res.json() : null;
}

/** Generic JSON call to the backend, dev-org scoped (anonymous ⇒ dev org). Used
 *  by the route scenarios to seed real fixtures (skills / knowledge / docs) that
 *  the UI then renders. Every fixture carries the TAG so cleanup deletes only ours. */
export async function beApi(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BE}${path}`, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", Origin: "http://localhost:3200" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

export async function getThread(id: string): Promise<any[]> {
  const res = await fetch(`${BE}/api/runs/${id}?thread=1`, { headers: { Origin: "http://localhost:3200" } });
  if (!res.ok) return [];
  const j = await res.json();
  return j.thread ?? [];
}

export async function waitRun(
  id: string,
  pred: (r: any) => boolean,
  budgetMs = 90_000,
): Promise<any> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const r = await getRun(id);
    if (r && pred(r)) return r;
    await sleep(500);
  }
  throw new Error(`waitRun timed out for ${id}`);
}

/** Launch a fresh headless Chrome page with console-error capture. */
export async function newPage(browser: Browser): Promise<{ page: Page; consoleErrors: string[]; pageErrors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  return { page, consoleErrors, pageErrors };
}

export async function launch(): Promise<Browser> {
  await Bun.$`mkdir -p ${SHOTS}`.quiet().catch(() => {});
  return chromium.launch({ channel: "chrome", headless: true });
}

export async function shot(page: Page, name: string): Promise<string> {
  const path = `${SHOTS}${name}.png`;
  await page.screenshot({ path, fullPage: false }).catch(() => {});
  return path;
}

/** Build a result from a checklist; verdict = FAIL if any required check failed. */
export function verdictOf(scenario: string, checks: { name: string; ok: boolean; note?: string }[], detail = ""): Result {
  const anyFail = checks.some((c) => !c.ok);
  return { scenario, verdict: anyFail ? "FAIL" : "PASS", detail, checks };
}

export function printResult(r: Result): void {
  const icon = r.verdict === "PASS" ? "✅" : r.verdict === "SKIP" ? "⏭️ " : "❌";
  console.log(`\n${icon} [${r.verdict}] ${r.scenario}${r.detail ? ` — ${r.detail}` : ""}`);
  for (const c of r.checks) {
    console.log(`     ${c.ok ? "✓" : "✗"} ${c.name}${c.note ? ` — ${c.note}` : ""}`);
  }
}
