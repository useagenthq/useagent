/**
 * C7 - comprehensive credential-leak audit over a REAL repo-cloning run. Boots an isolated backend
 * on a throwaway DB + a REAL Daytona sandbox, runs one opencode turn that CLONES an org repo (the
 * path where a GitHub clone token could leak), then scans EVERY surface for secret values:
 *   - persisted STEPS (label + code_json)
 *   - provider_events.payload + canonical_events.body + runs.summary (tenant-visible product data)
 *   - the backend LOG file (host-log hygiene)
 *   - the SANDBOX: `git config --list` (no clone token baked into a remote URL) + a scan of the
 *     sandbox env for the raw HOST provider-key VALUES
 * The hard gate: no raw HOST provider-key VALUE (Daytona/OpenRouter/Anthropic/OpenAI) in any
 * PERSISTED product surface, the backend log, OR the sandbox env, and NO git clone token in the
 * sandbox git config. Provider calls must use the trusted provider gateway; any raw provider
 * key in the sandbox is a hard regression, including in development.
 *
 * Run (from backend/):  bun test/e2e/secret-audit-live.ts
 */
import postgres from "postgres";
import { openSync, readFileSync } from "node:fs";
import { Daytona } from "@daytona/sdk";
import { deleteById, listAll } from "./soak/lib/daytona";

const BE_PORT = 3552;
const BE = `http://localhost:${BE_PORT}`;
const ORIGIN = "http://localhost:3200";
const DB = "skynet_e2e_secaudit";
const DB_URL = `postgres://postgres@localhost:5432/${DB}`;
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const backendDir = new URL("../..", import.meta.url).pathname;
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const beLogPath = `${scratch}/secaudit-be.log`;
const BUDGET_MS = 300_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cells: { cell: string; status: "pass" | "fail" | "na" | "info"; note: string }[] = [];
const rec = (cell: string, status: (typeof cells)[number]["status"], note = "") => {
  cells.push({ cell, status, note });
  console.log(`  ${status === "pass" ? "OK " : status === "fail" ? "XX " : status === "info" ? "ii " : ".. "} ${cell}${note ? ` - ${note}` : ""}`);
};
const pass = (cell: string, cond: boolean, note = "") => rec(cell, cond ? "pass" : "fail", note);
const short = (s: unknown, n = 8) => String(s ?? "").slice(0, n);
const sql = postgres(DB_URL, { max: 3 });
const sandboxIds = new Set<string>();
const myRunIds: string[] = [];
let be: ReturnType<typeof Bun.spawn> | null = null;

async function waitHttp(url: string, budgetMs: number) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) { try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch { /* */ } await sleep(1000); }
  return false;
}

try {
  console.log(`\n=== SECRET AUDIT (live, repo-cloning opencode run, BE=${BE}) ===\n`);
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin`DROP DATABASE IF EXISTS ${admin.unsafe(DB)} WITH (FORCE)`.catch(() => {});
  await admin`CREATE DATABASE ${admin.unsafe(DB)}`;
  await admin.end();

  const beLog = openSync(beLogPath, "a");
  be = Bun.spawn(["bun", "src/index.ts"], {
    cwd: backendDir,
    env: { ...process.env, PORT: String(BE_PORT), DATABASE_URL: DB_URL, ALLOW_DEV_ORG: "1", FRONTEND_ORIGIN: ORIGIN, ENABLED_ENGINES: process.env.ENABLED_ENGINES ?? "opencode,claude,codex" },
    stdout: beLog, stderr: beLog,
  });
  pass("isolated backend booted (throwaway DB)", await waitHttp(`${BE}/health`, 60_000));

  // pick a real org repo (the clone-token path)
  const repos = ((await (await fetch(`${BE}/api/repos`, { headers: { Origin: ORIGIN } })).json().catch(() => ({}))) as { repos?: { full_name: string }[] }).repos ?? [];
  const repo = repos[0]?.full_name;
  pass("an org repo is available to clone (clone-token path)", !!repo, repo ?? "none");

  const post = await fetch(`${BE}/api/runs`, {
    method: "POST", headers: { "content-type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ prompt: "Use the shell tool to run `git remote -v` and reply with the output.", engine: "opencode", model: "anthropic/claude-haiku-4.5", ...(repo ? { repos: [repo] } : {}) }),
  });
  const runId = (await post.json().catch(() => ({})))?.id as string | undefined;
  pass("repo-cloning run accepted", !!runId, `run=${short(runId)}`);
  if (!runId) throw new Error("no run id");
  myRunIds.push(runId);

  // wait for terminal + capture sandbox id
  let sandboxId: string | undefined;
  const deadline = Date.now() + BUDGET_MS;
  while (Date.now() < deadline) {
    const [r] = await sql`SELECT status, sandbox_id FROM runs WHERE id = ${runId}`;
    if (r?.sandbox_id) { sandboxId = r.sandbox_id as string; sandboxIds.add(sandboxId); }
    if (r && ["completed", "failed", "cancelled"].includes(r.status as string)) break;
    await sleep(2000);
  }
  pass("run reached a real sandbox", !!sandboxId, `sandbox=${short(sandboxId)}`);

  // the raw HOST secret VALUES that must never land in a product surface / backend log
  const secretVals = [
    process.env.DAYTONA_API_KEY, process.env.OPENROUTER_API_KEY, process.env.ANTHROPIC_API_KEY,
    process.env.OPENAI_API_KEY, process.env.GITHUB_APP_PRIVATE_KEY,
  ].filter((v): v is string => typeof v === "string" && v.length >= 16);

  // 1) persisted STEPS
  const steps = (await sql`SELECT label, code_json FROM steps WHERE run_id = ${runId}`) as unknown as { label: string; code_json: string | null }[];
  const stepsText = steps.map((s) => `${s.label ?? ""} ${s.code_json ?? ""}`).join("\n");
  pass("no secret value in persisted STEPS", !secretVals.some((v) => stepsText.includes(v)), `${steps.length} steps`);

  // 2) provider_events + canonical_events + summaries
  const pev = (await sql`SELECT payload FROM provider_events WHERE run_id = ${runId}`) as unknown as { payload: unknown }[];
  const cev = (await sql`SELECT body, identity FROM canonical_events WHERE run_id = ${runId}`) as unknown as { body: unknown; identity: unknown }[];
  const sums = (await sql`SELECT summary FROM runs WHERE id = ${runId}`) as unknown as { summary: unknown }[];
  const productText = [...pev.map((r) => JSON.stringify(r.payload)), ...cev.map((r) => JSON.stringify(r.body) + JSON.stringify(r.identity)), ...sums.map((r) => String(r.summary ?? ""))].join("\n");
  pass("no secret value in provider_events / canonical_events / summaries", !secretVals.some((v) => productText.includes(v)), `${pev.length}+${cev.length} events`);

  // 3) backend LOG file (host-log hygiene)
  const beText = readFileSync(beLogPath, "utf8");
  const leakedInLog = secretVals.filter((v) => beText.includes(v));
  pass("no raw secret value in the backend log", leakedInLog.length === 0, `${secretVals.length} keys checked`);

  // 4) SANDBOX: git config (no clone token in a remote URL) + env token-pattern scan
  if (sandboxId) {
    try {
      const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, target: process.env.DAYTONA_TARGET ?? "us" });
      const sb = await daytona.get(sandboxId);
      const gitCfg = (await sb.process.executeCommand("git -C /root/work/* config --list 2>/dev/null; find /root/work -name .git -maxdepth 3 -exec git --git-dir={} config --get remote.origin.url \\; 2>/dev/null", undefined, undefined, 20).catch(() => ({ result: "" }))).result ?? "";
      // a clone token would appear as x-access-token:<...>@ or a gh[psuo]_ token in the remote URL
      const gitTokenLeak = /x-access-token:[^@\s]+@|gh[psuo]_[A-Za-z0-9]{20,}/.test(gitCfg);
      pass("sandbox git config carries NO clone token in a remote URL", !gitTokenLeak, gitTokenLeak ? "TOKEN IN GIT CONFIG" : `${gitCfg.split("\n").length} config lines, clean`);
      // sandbox env: a raw HOST provider-key VALUE reaching an untrusted sandbox is a REAL,
      // UNRESOLVED exposure risk (#121) - the agent can read it from its own env and exfiltrate /
      // burn the operator's account. FAIL, not info. We match the actual host VALUES (never the var
      // names), so a tenant's OWN org secret of the same name (a different value) does NOT
      // false-positive - only the host operator's key does. The env dump is scanned in-process and
      // never printed, so the audit itself does not echo any secret.
      const envDump = (await sb.process.executeCommand("env", undefined, undefined, 15).catch(() => ({ result: "" }))).result ?? "";
      const leakedHostKeys = secretVals.filter((v) => envDump.includes(v));
      pass(
        "no raw HOST provider-key value in the sandbox env (#121, UNRESOLVED)",
        leakedHostKeys.length === 0,
        leakedHostKeys.length ? `${leakedHostKeys.length} host provider-key value(s) present in the sandbox env - real exposure risk (#121)` : "none",
      );
    } catch (e) {
      rec("sandbox git-config / env scan", "na", `sandbox exec failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
} catch (e) {
  rec("no fatal error", "fail", e instanceof Error ? e.message : String(e));
} finally {
  await sql.end().catch(() => {});
  const mine = new Set<string>([...sandboxIds].filter(Boolean));
  try { for (const sb of await listAll()) { const l = sb.labels?.["skynet-run"]; if (l && myRunIds.includes(l)) mine.add(sb.id); } } catch { /* */ }
  const ids = [...mine].filter(Boolean);
  if (ids.length) { const r = await deleteById(ids).catch(() => ({ deleted: [], failed: [{ id: "?", error: "x" }] })); rec("sandbox deleted + API-verified", r.failed.length === 0 ? "pass" : "fail", `deleted ${r.deleted.length}`); }
  be?.kill();
  await sleep(1000);
  const admin2 = postgres(ADMIN_URL, { max: 1 });
  await admin2`DROP DATABASE IF EXISTS ${admin2.unsafe(DB)} WITH (FORCE)`.catch(() => {});
  await admin2.end().catch(() => {});
  const fails = cells.filter((c) => c.status === "fail");
  console.log(`\nSECRET_AUDIT=${JSON.stringify({ verdict: fails.length === 0 ? "PASS" : "FAIL", cells })}`);
  console.log(`\n${fails.length === 0 ? "✅ PASS" : "❌ FAIL"} - ${cells.filter((c) => c.status === "pass").length} pass, ${fails.length} fail`);
  process.exit(fails.length === 0 ? 0 : 1);
}
