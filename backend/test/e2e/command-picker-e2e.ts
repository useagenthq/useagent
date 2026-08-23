/**
 * SELF-BOOTING browser E2E for the Claude/Codex native slash-command picker.
 *
 * Proves the capability wiring END-TO-END in a real Chromium against a REAL isolated stack -
 * NOT a component stub - WITHOUT spending a Daytona sandbox or an LLM token:
 *   - a claude (and codex) thread's session page renders the composer "/" popover populated
 *     with the provider's native slash commands, sourced capability-driven from GET /api/commands
 *   - picking a command inserts it BYTE-VERBATIM ("/name ") into the composer (invocation)
 *   - a reload re-renders the same catalog (durable across a reconnect)
 *
 * Deterministic seam: it boots its OWN backend on a throwaway DB + its OWN frontend (isolated
 * dist dir), settles a `mock` run (no sandbox), relabels the thread's engine to claude/codex,
 * and seeds that engine's command catalog directly (the exact row the ACP relay's
 * available_commands_update writes via cacheAcpCommands). So the browser exercises the real
 * frontend picker + real /api/commands route + real DB, with zero cloud cost and zero flake
 * from whether a specific ACP build advertises commands on a given day.
 *
 * Run (from backend/):  bun test/e2e/command-picker-e2e.ts
 * Self-cleaning: kills both procs, drops the DB, restores the isolated dist dir + tsconfig.
 * NOT part of `bun test` (spawns a frontend dev server + Chromium). Nonzero exit on any FAIL.
 */
import { chromium, type Browser, type Page } from "playwright-core";
import postgres from "postgres";
import { closeSync, openSync } from "node:fs";
import { readFileSync, writeFileSync, rmSync } from "node:fs";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const DB = "skynet_e2e_cmd";
const DB_URL = `postgres://postgres@localhost:5432/${DB}`;
const BE_PORT = 3522;
const FE_PORT = 3422;
const BE = `http://localhost:${BE_PORT}`;
const FE = `http://localhost:${FE_PORT}`;
const DIST = ".next-cmd-e2e";
const DEV_ORG_ID = "org-skynet-dev"; // anonymous (dev-org) requests scope here; the catalog key must match
const SHOTS = process.env.CMD_E2E_SHOTS ?? "/tmp/cmd-picker-shots/";

const backendDir = new URL("../..", import.meta.url).pathname;
const frontendDir = new URL("../../../frontend", import.meta.url).pathname;
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const checks: { name: string; ok: boolean; note?: string }[] = [];
const ok = (name: string, cond: boolean, note = "") => {
  checks.push({ name, ok: cond, note });
  console.log(`  ${cond ? "OK " : "XX "} ${name}${note ? ` - ${note}` : ""}`);
};

type Proc = ReturnType<typeof Bun.spawn>;

async function waitHttp(url: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true; // 404 still means the server answered
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

async function main() {
  console.log(`[cmd-picker-e2e] BE=${BE} FE=${FE} DB=${DB}`);
  await Bun.$`mkdir -p ${SHOTS}`.quiet().catch(() => {});

  // ── 1. fresh throwaway DB ──────────────────────────────────────────────────
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin`DROP DATABASE IF EXISTS ${admin.unsafe(DB)} WITH (FORCE)`.catch(() => {});
  await admin`CREATE DATABASE ${admin.unsafe(DB)}`;
  await admin.end();

  // snapshot the isolated-dist tsconfig include (next dev mutates tsconfig.json — restore it)
  const tsconfigPath = `${frontendDir}/tsconfig.json`;
  const tsconfigBefore = readFileSync(tsconfigPath, "utf8");

  let be: Proc | null = null;
  let fe: Proc | null = null;
  let browser: Browser | null = null;
  const sql = postgres(DB_URL, { max: 2 });
  let failed = false;

  try {
    // ── 2. boot backend on the throwaway DB (mock engine only, no cloud) ──────
    const beLog = openSync(`${scratch}/skynet-cmd-e2e-backend.log`, "a");
    try {
      be = Bun.spawn(["bun", "src/index.ts"], {
        cwd: backendDir,
        env: {
          ...process.env,
          PORT: String(BE_PORT),
          DATABASE_URL: DB_URL,
          ALLOW_DEV_ORG: "1",
          FRONTEND_ORIGIN: FE,
          // keep every optional integration a no-op — this proof is DB + HTTP + browser only
          MEMORY_API_URL: "",
          SLACK_BOT_TOKEN: "",
          DAYTONA_API_KEY: "",
        },
        stdout: beLog,
        stderr: beLog,
      });
    } finally {
      closeSync(beLog);
    }
    ok("backend booted", await waitHttp(`${BE}/health`, 60_000));

    // ── 3. boot the frontend (isolated dist, rewrites -> our backend) ─────────
    const feLog = openSync(`${scratch}/skynet-cmd-e2e-frontend.log`, "a");
    try {
      fe = Bun.spawn(["bun", "run", "dev", "--port", String(FE_PORT)], {
        cwd: frontendDir,
        env: {
          ...process.env,
          PORT: String(FE_PORT),
          USEAGENT_API_ORIGIN: BE,
          USEAGENT_BUILD_DIST: DIST,
        },
        stdout: feLog,
        stderr: feLog,
      });
    } finally {
      closeSync(feLog);
    }
    ok("frontend booted", await waitHttp(`${FE}/agent/new`, 120_000));

    browser = await chromium.launch({ channel: "chrome", headless: true });

    // ── 4. per-engine: settle a mock run, relabel it, seed its catalog, prove ──
    for (const engine of ["claude", "codex"] as const) {
      const cmds =
        engine === "claude"
          ? [
              { name: "review", description: "Review the working changes", input: "[files]" },
              { name: "compact", description: "Compact the conversation" },
            ]
          : [
              { name: "diff", description: "Show the working diff" },
              { name: "status", description: "Show session status" },
            ];
      const first = cmds[0]!.name;

      // settle a real thread cheaply on the mock engine (no sandbox), then relabel to the engine
      const res = await fetch(`${BE}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: FE },
        body: JSON.stringify({ prompt: `${engine} command-picker fixture`, engine: "mock", model: "claude-haiku-4-5" }),
      });
      const runId = (await res.json().catch(() => ({})))?.id as string | undefined;
      ok(`[${engine}] fixture run created`, !!runId, runId ?? "no id");
      if (!runId) {
        failed = true;
        continue;
      }
      // wait until the mock run settles so the session page renders a stable composer
      for (let i = 0; i < 40; i++) {
        const r = await fetch(`${BE}/api/runs/${runId}`, { headers: { Origin: FE } }).then((x) => x.json()).catch(() => null);
        if (r && ["completed", "failed", "cancelled"].includes(r.status)) break;
        await sleep(500);
      }
      await sql`UPDATE runs SET engine = ${engine} WHERE thread_id = ${runId}`;
      // seed the catalog the ACP relay would have written (cacheAcpCommands -> acp:<org>:<engine>)
      const key = `acp:${DEV_ORG_ID}:${engine}`;
      await sql`
        INSERT INTO commands_catalog (snapshot, commands, fetched_at)
        VALUES (${key}, ${sql.json(cmds)}, now())
        ON CONFLICT (snapshot) DO UPDATE SET commands = EXCLUDED.commands, fetched_at = now()`;

      const page: Page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const consoleErrors: string[] = [];
      const networkErrors: string[] = [];
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
      page.on("response", (response) => {
        if (response.status() >= 400 && !/\/favicon\.ico(?:\?|$)/i.test(response.url())) {
          networkErrors.push(`HTTP ${response.status()} ${response.url()}`);
        }
      });
      page.on("requestfailed", (request) => {
        const reason = request.failure()?.errorText ?? "request failed";
        if (reason !== "net::ERR_ABORTED") {
          networkErrors.push(`${reason} ${request.url()}`);
        }
      });

      await page.goto(`${FE}/session/${runId}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
      // the REPLY composer specifically (a session page also mounts Monaco, whose hidden
      // textarea would otherwise be matched by a bare `textarea` selector). `:visible`
      // scopes to the mounted composer: on RELOAD the tree double-renders and settles, so a
      // stale hidden copy can briefly coexist - we always drive the visible one.
      const composer = () => page.locator('textarea[placeholder*="Reply to Skynet"]:visible');
      await composer().waitFor({ state: "visible", timeout: 60_000 });

      // type "/" -> the native-command popover appears with the seeded commands. The picker
      // fetches the catalog on mount; give the fetch a beat before typing.
      await sleep(1500);
      await composer().click();
      await composer().fill("/");
      const btnFirst = page.locator("button", { hasText: `/${cmds[0]!.name}` });
      const btnSecond = page.locator("button", { hasText: `/${cmds[1]!.name}` });
      const popoverShown = await btnFirst.first().isVisible({ timeout: 15_000 }).catch(() => false);
      ok(`[${engine}] "/" opens the native command popover`, popoverShown);
      ok(`[${engine}] popover lists native command /${cmds[0]!.name}`, popoverShown);
      ok(`[${engine}] popover lists native command /${cmds[1]!.name}`, await btnSecond.first().isVisible().catch(() => false));
      await shot(page, `${engine}-popover`);

      // Phase 7 UX/a11y: a truthful provider SOURCE label, ARIA listbox/option semantics, and the
      // provider's input hint rendered next to the command.
      const sourceLabel = engine === "claude" ? "Claude commands" : "Codex commands";
      ok(`[${engine}] popover shows the provider source label "${sourceLabel}"`, await page.getByText(sourceLabel, { exact: true }).first().isVisible().catch(() => false));
      ok(`[${engine}] popover has ARIA role=listbox`, await page.locator('[role="listbox"]').first().isVisible().catch(() => false));
      ok(`[${engine}] commands are ARIA role=option`, (await page.locator('[role="option"]').count()) >= 2);
      const hint = cmds.find((c) => "input" in c && (c as { input?: string }).input) as { input?: string } | undefined;
      if (hint?.input) {
        ok(`[${engine}] popover shows the input hint "${hint.input}"`, await page.getByText(hint.input, { exact: false }).first().isVisible().catch(() => false));
      }

      // picking inserts the command BYTE-VERBATIM: "/name " (invocation)
      await btnFirst.first().click();
      const afterPick = await composer().inputValue();
      ok(`[${engine}] picking inserts "/${first} " verbatim`, afterPick === `/${first} `, JSON.stringify(afterPick));

      // reload -> the catalog re-renders (durable across a reconnect)
      await page.reload({ waitUntil: "domcontentloaded", timeout: 120_000 });
      await composer().waitFor({ state: "visible", timeout: 60_000 });
      await sleep(1500);
      // steady state after the reload double-render settles: exactly ONE composer is visible
      // (duplicate-visible composer would mean duplicate combobox/aria ids - a real a11y bug).
      ok(`[${engine}] exactly one reply composer visible after reload`, (await composer().count()) === 1, String(await composer().count()));
      await composer().click();
      await composer().fill("/");
      const reBtn = page.locator("button", { hasText: `/${first}` });
      ok(`[${engine}] catalog persists across reload`, await reBtn.first().isVisible({ timeout: 15_000 }).catch(() => false));

      // Chromium's generic message omits the URL. Network listeners above are
      // the authoritative URL/status oracle; only an optional favicon is exempt.
      const appErrors = [
        ...consoleErrors.filter(
          (error) => !/Failed to load resource|favicon\.ico/i.test(error),
        ),
        ...networkErrors,
      ];
      ok(`[${engine}] no app console errors on the session page`, appErrors.length === 0, appErrors.slice(0, 2).join(" | "));
      await page.close();
    }
  } catch (e) {
    failed = true;
    ok("run completed without throwing", false, e instanceof Error ? e.message : String(e));
  } finally {
    await browser?.close().catch(() => {});
    await sql.end().catch(() => {});
    be?.kill();
    fe?.kill();
    await sleep(1500);
    // restore the isolated-dist tsconfig mutation + drop the throwaway artifacts
    if (readFileSync(tsconfigPath, "utf8") !== tsconfigBefore) writeFileSync(tsconfigPath, tsconfigBefore);
    rmSync(`${frontendDir}/${DIST}`, { recursive: true, force: true });
    const admin2 = postgres(ADMIN_URL, { max: 1 });
    await admin2`DROP DATABASE IF EXISTS ${admin2.unsafe(DB)} WITH (FORCE)`.catch(() => {});
    await admin2.end();
  }

  const passed = checks.filter((c) => c.ok).length;
  const verdict = { scenario: "command-picker-e2e", passed, total: checks.length, ok: !failed && passed === checks.length };
  console.log(`\n[cmd-picker-e2e] ${JSON.stringify(verdict)}`);
  process.exit(verdict.ok ? 0 : 1);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: false }).catch(() => {});
}

main();
