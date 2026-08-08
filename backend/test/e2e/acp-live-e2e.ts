/**
 * LIVE ACP (Claude / Codex) E2E through real Daytona - CLIENT of the running backend
 * (BE_ORIGIN, default :3501), so it boots NO second backend (no shared-DB recovery hazard).
 * Proves, per engine: multi-turn, reload (durable thread reconstruct), and IN-FLIGHT cancel
 * (Slice 4 native session/cancel: the run settles "Stopped by user" mid-flight). Self-cleaning:
 * deletes + API-verifies every Daytona sandbox it touched.
 *
 * Run:  E2E_ENGINE=claude bun test/e2e/acp-live-e2e.ts
 *       E2E_ENGINE=codex  E2E_MODEL=gpt-5 bun test/e2e/acp-live-e2e.ts
 */
import postgres from "postgres";
import { deleteById, listAll } from "./soak/lib/daytona";

const BE = process.env.BE_ORIGIN ?? "http://localhost:3501";
const ORIGIN = "http://localhost:3200"; // dev org (anonymous)
const ENGINE = process.env.E2E_ENGINE ?? "claude";
const MODEL = process.env.E2E_MODEL ?? (ENGINE === "codex" ? "gpt-5" : "claude-haiku-4-5");
const DB = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/skynet";
const BOOT_BUDGET = Number(process.env.E2E_BOOT_BUDGET_S ?? 240); // ACP relay install can be slow first time

const LONG_PROMPT =
  "Use the shell/execute tool to run EXACTLY this one command and WAIT for it to fully finish before you reply: " +
  "`sleep 90`. Do NOT run any other command and do NOT reply until it has completed.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sql = postgres(DB, { max: 2 });
const checks: { name: string; ok: boolean; note?: string }[] = [];
const add = (name: string, ok: boolean, note?: string) => {
  checks.push({ name, ok, note });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? ` - ${note}` : ""}`);
};
const sandboxIds = new Set<string>(); // persisted sandbox ids seen (primary cleanup)
const myRunIds: string[] = []; // this test's run ids (label-fallback cleanup)

async function post(path: string, body: unknown) {
  const res = await fetch(`${BE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
async function getRun(id: string) {
  const res = await fetch(`${BE}/api/runs/${id}`, { headers: { Origin: ORIGIN } });
  return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
}
async function dbRun(id: string) {
  const [r] = await sql`
    SELECT id, status, summary, thread_id, parent_run_id, engine, engine_session_id, sandbox_id
    FROM runs WHERE id = ${id}`;
  return r as Record<string, unknown> | undefined;
}
async function waitTerminal(id: string, budgetS: number): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < budgetS / 2; i++) {
    const r = await getRun(id);
    if (r?.sandbox_id) sandboxIds.add(r.sandbox_id as string);
    const d = await dbRun(id);
    if (d?.sandbox_id) sandboxIds.add(d.sandbox_id as string);
    if (r && (r.status === "completed" || r.status === "failed" || r.status === "cancelled")) return r;
    await sleep(2000);
  }
  return null;
}

try {
  console.log(`\n=== LIVE ACP E2E (engine=${ENGINE}, model=${MODEL}, BE=${BE}) ===\n`);

  // 1. TURN 1 (multi-turn part 1)
  const t1 = await post("/api/runs", { prompt: "Reply with exactly the word PING. Do not run any tools.", engine: ENGINE, model: MODEL });
  const run1 = t1.body?.id as string | undefined;
  add(`turn 1 accepted (${ENGINE})`, (t1.status === 200 || t1.status === 201) && !!run1, `HTTP ${t1.status} id=${run1?.slice(0, 8) ?? t1.body?.error}`);
  if (!run1) throw new Error("no run1 id");
  myRunIds.push(run1);
  const d1 = await waitTerminal(run1, BOOT_BUDGET);
  add("turn 1 completed", d1?.status === "completed", `status=${d1?.status} summary="${String(d1?.summary).slice(0, 40)}"`);
  const box1 = (await dbRun(run1))?.sandbox_id as string | undefined;
  add("turn 1 persisted a NON-NULL sandbox_id (durable, Blocker 3)", !!box1, `sandbox=${box1?.slice(0, 8) ?? "NULL"}`);

  // 2. TURN 2 - reply in the SAME thread (multi-turn part 2)
  const t2 = await post("/api/runs", { prompt: "Now reply with exactly the word PONG. Do not run any tools.", engine: ENGINE, model: MODEL, parent_run_id: run1 });
  const run2 = t2.body?.id as string | undefined;
  add("turn 2 (reply) accepted", (t2.status === 200 || t2.status === 201) && !!run2, `HTTP ${t2.status} id=${run2?.slice(0, 8)}`);
  if (!run2) throw new Error("no run2 id");
  myRunIds.push(run2);
  const d2 = await waitTerminal(run2, BOOT_BUDGET);
  add("turn 2 completed", d2?.status === "completed", `status=${d2?.status}`);
  const db1 = await dbRun(run1); const db2 = await dbRun(run2);
  add("turn 2 joined the SAME thread as turn 1", !!db1?.thread_id && db2?.thread_id === db1?.thread_id, `thread ${String(db2?.thread_id).slice(0, 8)}`);
  add(
    "reply run REUSES the same resident sandbox id (Blocker 3)",
    !!db1?.sandbox_id && db2?.sandbox_id === db1?.sandbox_id,
    `turn1=${String(db1?.sandbox_id).slice(0, 8)} turn2=${String(db2?.sandbox_id).slice(0, 8)}`,
  );

  // 3. RELOAD - the durable thread endpoint reconstructs BOTH turns (what a browser reload rebuilds from)
  const thr = await fetch(`${BE}/api/runs/${run1}?thread=1`, { headers: { Origin: ORIGIN } });
  const thread = ((await thr.json().catch(() => ({}))) as { thread?: Record<string, unknown>[] }).thread ?? [];
  const bothPresent = thread.some((r) => r.id === run1) && thread.some((r) => r.id === run2);
  add("reload: thread reconstruct has BOTH turns, turn 1 intact", bothPresent && thread.length >= 2, `${thread.length} runs`);

  // 4. IN-FLIGHT CANCEL - long run, cancel mid-flight, must settle "Stopped by user" well before the ~90s task
  const t3 = await post("/api/runs", { prompt: LONG_PROMPT, engine: ENGINE, model: MODEL, parent_run_id: run1 });
  const run3 = t3.body?.id as string | undefined;
  add("cancel-run accepted", (t3.status === 200 || t3.status === 201) && !!run3, `HTTP ${t3.status} id=${run3?.slice(0, 8)}`);
  if (!run3) throw new Error("no run3 id");
  myRunIds.push(run3);

  // Wait until a real TOOL step is executing (kind==="command"), NOT the startup
  // "Running <engine> (resident)…" task marker - then cancel PROMPTLY. Codex ends a turn
  // much faster than Claude, so a fixed pre-cancel sleep can let it settle first; the
  // instant a command step is running we Stop, so the cancel is genuinely mid-flight.
  const startWait = Date.now();
  let running = false;
  let settledEarly: Record<string, unknown> | null = null;
  for (let i = 0; i < Math.ceil(BOOT_BUDGET / 0.75); i++) {
    const r = await getRun(run3);
    if (r?.sandbox_id) sandboxIds.add(r.sandbox_id as string);
    const steps = (r?.steps as { kind?: string }[]) ?? [];
    if (r?.status === "running" && steps.some((s) => s.kind === "command")) { running = true; break; }
    if (r && (r.status === "failed" || r.status === "completed" || r.status === "cancelled")) { settledEarly = r; break; }
    await sleep(750);
  }
  add(
    "cancel-run reached a RUNNING tool step (genuinely mid-flight)",
    running,
    running ? `after ${Math.round((Date.now() - startWait) / 1000)}s` : `settled early: ${settledEarly?.status} ("${String(settledEarly?.summary).slice(0, 40)}")`,
  );

  const cancelAt = Date.now();
  const cancel = await post(`/api/runs/${run3}/cancel`, {});
  add("in-flight cancel accepted (durable)", cancel.status === 200 || cancel.status === 202, `HTTP ${cancel.status}`);
  const settled = await waitTerminal(run3, 100);
  const stopLatency = Math.round((Date.now() - cancelAt) / 1000);
  const totalS = Math.round((Date.now() - startWait) / 1000);
  add("cancel-run settled after cancel", !!settled, `status=${settled?.status} in ${stopLatency}s`);
  add('cancel-run durable status is "Stopped by user"', settled?.summary === "Stopped by user", `summary="${String(settled?.summary).slice(0, 40)}"`);
  add("aborted MID-FLIGHT (settled well before the ~90s task)", !!settled && totalS < 80, `${totalS}s total`);
} catch (e) {
  add("no fatal error", false, e instanceof Error ? e.message : String(e));
} finally {
  await sql.end();
  // Fail-safe cleanup: delete ONLY sandboxes this test is responsible for.
  //  (1) PRIMARY: every persisted sandbox id we observed (durable runs.sandbox_id + live GET).
  //  (2) FALLBACK: any Daytona box whose `skynet-run` label is one of THIS test's run ids
  //      (covers a provision that never made it into runs.sandbox_id). We match on our own
  //      run ids, so an unrelated agent's sandbox can never be swept.
  const mine = new Set<string>([...sandboxIds].filter(Boolean));
  const myRuns = new Set(myRunIds);
  try {
    const all = await listAll();
    for (const sb of all) {
      const runLabel = sb.labels?.["skynet-run"];
      if (runLabel && myRuns.has(runLabel)) mine.add(sb.id);
    }
  } catch (err) {
    console.warn(`[cleanup] label-fallback scan failed (using persisted ids only): ${String(err)}`);
  }
  const ids = [...mine].filter(Boolean);
  if (ids.length) {
    console.log(`\n[cleanup] deleting ${ids.length} sandbox(es): ${ids.join(", ")}`);
    const res = await deleteById(ids).catch((err) => ({ deleted: [] as string[], failed: [{ id: "?", error: String(err) }] }));
    add("sandbox(es) deleted + API-verified gone", res.failed.length === 0, `deleted ${res.deleted.length}, failed ${res.failed.length}`);
  } else {
    add("no sandbox to clean (nothing provisioned)", true);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? "✅ PASS" : "❌ FAIL"} (${ENGINE}) - ${checks.length - failed.length}/${checks.length} checks`);
  if (failed.length) console.log("FAILED:", failed.map((c) => c.name).join(" | "));
  process.exit(failed.length === 0 ? 0 : 1);
}
