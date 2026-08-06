/**
 * Soak orchestrator — runs the five storms in rotation, CONTINUOUSLY, for the
 * marathon (8–12h). Each iteration spawns one storm script as an isolated
 * subprocess (fresh SEED + throwaway DB), parses its SOAK_RESULT line, and folds
 * it into cumulative state. Writes a rolling report (state/report.json +
 * report.md) after every storm, and appends operator ALERTS (new defect
 * signatures, per-interval heartbeats, storm crashes) to state/alerts.log — which
 * the QA agent tails to know when to report to the lead.
 *
 *   bun run soak            # from backend/ (see package.json)
 * Stop cleanly by creating state/STOP (touch it); the loop exits after the
 * current storm. Tunables via env (SOAK_HEARTBEAT_MIN, per-storm counts…).
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { StormResult, Defect } from "./lib/report";

const SOAK_DIR = new URL(".", import.meta.url).pathname;
const STATE = join(SOAK_DIR, "state");
mkdirSync(STATE, { recursive: true });
const REPORT_JSON = join(STATE, "report.json");
const REPORT_MD = join(STATE, "report.md");
const ALERTS = join(STATE, "alerts.log");
const STOP = join(STATE, "STOP");

const HEARTBEAT_MS = Number(process.env.SOAK_HEARTBEAT_MIN ?? 90) * 60_000;
const STORM_TIMEOUT_MS = Number(process.env.SOAK_STORM_TIMEOUT_MIN ?? 6) * 60_000;
const startedAt = Date.now();

// One storm cycle per rotation slot. Counts sized so a slot is ~1–3 min; the
// marathon accumulates thousands cumulatively. `port` base keeps sequential
// storms off each other and off other agents' 3501–3515.
interface StormDef { name: string; script: string; env: Record<string, string>; }
const BASE_PORT = process.env.SOAK_PORT ?? "3516";
const STORMS: StormDef[] = [
  { name: "conversation", script: "storms/conversation.ts", env: { SOAK_PORT: BASE_PORT, SOAK_CONV_THREADS: process.env.SOAK_CONV_THREADS ?? "24", SOAK_CONV_REPLIES: process.env.SOAK_CONV_REPLIES ?? "6" } },
  { name: "native", script: "storms/native.ts", env: { SOAK_PORT: BASE_PORT, SOAK_NATIVE_RUNS: process.env.SOAK_NATIVE_RUNS ?? "24" } },
  { name: "outbox", script: "storms/outbox.ts", env: { SOAK_PORT: BASE_PORT, SOAK_OUTBOX_SLACK: process.env.SOAK_OUTBOX_SLACK ?? "500", SOAK_OUTBOX_MEM: process.env.SOAK_OUTBOX_MEM ?? "500" } },
  { name: "idempotency", script: "storms/idempotency.ts", env: { SOAK_PORT: BASE_PORT, SOAK_IDEM_ROUNDS: process.env.SOAK_IDEM_ROUNDS ?? "18", SOAK_IDEM_CONCURRENCY: process.env.SOAK_IDEM_CONCURRENCY ?? "40" } },
  { name: "crash", script: "storms/crash.ts", env: { SOAK_PORT: "3517", SOAK_MEM_PORT: "3527", SOAK_SLACK_PORT: "3528", SOAK_CRASH_CYCLES: process.env.SOAK_CRASH_CYCLES ?? "10" } },
  { name: "mem-atmost-once", script: "storms/mem-atmost-once.ts", env: { SOAK_PORT: "3519", SOAK_MEM_PORT: "3539", SOAK_MEMCRASH_CYCLES: process.env.SOAK_MEMCRASH_CYCLES ?? "6" } },
];

// ── cumulative state ──────────────────────────────────────────────────────────
interface StormAgg { cycles: number; iterations: number; checks: number; failures: number; crashes: number; stats: Record<string, number>; lastMs: number; }
interface DefectAgg { storm: string; invariant: string; count: number; firstDetail: string; firstEvidence: Record<string, unknown>; lastSeen: number; commit: string; }
const agg = new Map<string, StormAgg>();
const defects = new Map<string, DefectAgg>();
let rotations = 0;
let lastHeartbeat = Date.now();
let commit = "unknown";

function sh(cmd: string): string {
  try { return Bun.spawnSync(["bash", "-lc", cmd]).stdout.toString().trim(); } catch { return ""; }
}

function alert(line: string): void {
  const stamped = `[${new Date(startedAt + (Date.now() - startedAt)).toISOString()}] ${line}`;
  appendFileSync(ALERTS, stamped + "\n");
}

function foldDefect(d: Defect): void {
  const key = `${d.storm}::${d.invariant}`;
  const existing = defects.get(key);
  if (existing) {
    existing.count++;
    existing.lastSeen = Date.now();
  } else {
    defects.set(key, { storm: d.storm, invariant: d.invariant, count: 1, firstDetail: d.detail, firstEvidence: d.evidence, lastSeen: Date.now(), commit });
    alert(`NEW_DEFECT [${d.storm}] ${d.invariant} — ${d.detail} | seed=${d.evidence.seed} commit=${commit}`);
  }
}

function fold(r: StormResult): void {
  const a = agg.get(r.storm) ?? { cycles: 0, iterations: 0, checks: 0, failures: 0, crashes: 0, stats: {}, lastMs: 0 };
  a.cycles++; a.iterations += r.iterations; a.checks += r.checks; a.failures += r.failures; a.lastMs = r.ms;
  for (const [k, v] of Object.entries(r.stats)) a.stats[k] = (a.stats[k] ?? 0) + v;
  agg.set(r.storm, a);
  for (const d of r.defects) foldDefect(d);
}

function writeReport(): void {
  const uptimeMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
  const snapshot = {
    startedAt: new Date(startedAt).toISOString(),
    uptimeMin: Number(uptimeMin),
    rotations,
    commit,
    storms: Object.fromEntries(agg),
    defects: [...defects.values()].sort((a, b) => b.count - a.count),
  };
  writeFileSync(REPORT_JSON, JSON.stringify(snapshot, null, 2));

  const lines: string[] = [];
  lines.push(`# Soak report — uptime ${uptimeMin}min, ${rotations} rotations, commit ${commit}`);
  lines.push(`started ${new Date(startedAt).toISOString()}`);
  lines.push("");
  lines.push("## Storms (cumulative)");
  lines.push("| storm | cycles | iterations | checks | failures | crashes | last ms |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const [name, a] of agg) lines.push(`| ${name} | ${a.cycles} | ${a.iterations} | ${a.checks} | ${a.failures} | ${a.crashes} | ${a.lastMs} |`);
  lines.push("");
  lines.push("## Key volume");
  for (const [name, a] of agg) {
    const s = Object.entries(a.stats).map(([k, v]) => `${k}=${v}`).join(", ");
    if (s) lines.push(`- **${name}**: ${s}`);
  }
  lines.push("");
  lines.push(`## Defects (${defects.size} distinct signatures)`);
  if (defects.size === 0) lines.push("_none_");
  for (const d of [...defects.values()].sort((a, b) => b.count - a.count)) {
    lines.push(`- 🔴 **[${d.storm}] ${d.invariant}** ×${d.count} — ${d.firstDetail} (seed=${d.firstEvidence.seed}, commit ${d.commit})`);
  }
  writeFileSync(REPORT_MD, lines.join("\n"));
}

async function runStorm(def: StormDef): Promise<void> {
  const seed = String((Date.now() ^ (rotations * 2654435761)) >>> 0);
  const proc = Bun.spawn(["bun", def.script], {
    cwd: SOAK_DIR,
    env: { ...process.env, ...def.env, SOAK_SEED: seed },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => { try { proc.kill(9); } catch {} }, STORM_TIMEOUT_MS);
  let out = "";
  try {
    out = await new Response(proc.stdout).text();
    await proc.exited;
  } catch { /* killed */ }
  clearTimeout(timer);

  const m = out.match(/SOAK_RESULT=(\{.*\})/);
  if (!m) {
    // Storm crashed / timed out / produced no result — quarantine this cycle.
    const a = agg.get(def.name) ?? { cycles: 0, iterations: 0, checks: 0, failures: 0, crashes: 0, stats: {}, lastMs: 0 };
    a.crashes++; agg.set(def.name, a);
    alert(`STORM_CRASH [${def.name}] no SOAK_RESULT (exit=${proc.exitCode}) seed=${seed} — quarantined this cycle`);
    sweepPorts();
    return;
  }
  try {
    const r = JSON.parse(m[1]!) as StormResult;
    fold(r);
  } catch (err) {
    alert(`STORM_CRASH [${def.name}] unparseable SOAK_RESULT: ${(err as Error).message}`);
  }
}

/** Kill any lingering backend subprocess a crashed storm left on the soak ports
 *  (3516–3599 ONLY — never touch other agents' 3501–3515). */
function sweepPorts(): void {
  sh(`for p in $(seq 3516 3599); do lsof -ti tcp:$p -sTCP:LISTEN 2>/dev/null; done | sort -u | xargs -r kill -9 2>/dev/null; true`);
}

async function main(): Promise<void> {
  commit = sh("git rev-parse --short HEAD") || "unknown";
  alert(`SOAK_START commit=${commit} heartbeat=${HEARTBEAT_MS / 60000}min storms=${STORMS.map((s) => s.name).join(",")}`);
  sweepPorts(); // clean slate on the soak ports
  writeReport();

  while (!existsSync(STOP)) {
    const nextCommit = sh("git rev-parse --short HEAD");
    if (nextCommit && nextCommit !== commit) { alert(`HEAD_MOVED ${commit} → ${nextCommit}`); commit = nextCommit; }
    for (const def of STORMS) {
      if (existsSync(STOP)) break;
      await runStorm(def);
      writeReport();
      if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
        lastHeartbeat = Date.now();
        const totalChecks = [...agg.values()].reduce((n, a) => n + a.checks, 0);
        const totalFail = [...agg.values()].reduce((n, a) => n + a.failures, 0);
        alert(`HEARTBEAT uptime=${((Date.now() - startedAt) / 60000).toFixed(0)}min rotations=${rotations} checks=${totalChecks} failures=${totalFail} defects=${defects.size} commit=${commit}`);
      }
    }
    rotations++;
  }
  alert(`SOAK_STOP rotations=${rotations} defects=${defects.size}`);
  writeReport();
}

await main();
