/**
 * LIVE stop + resume proof (#135) - one real Daytona/OpenCode in-flight run.
 *
 * Proves the two Fix-C surfaces that cannot be asserted on a settled thread:
 *  1. ACTIVE STOP mid-flight: start a run that enters a long bash tool call, cancel
 *     it, and prove the process is aborted (run settles to failed/"Stopped by user"
 *     well before the bash could finish, with a partial tool output).
 *  2. RESUME: a follow-up (parent_run_id) joins the SAME thread + native session and
 *     completes; the thread SSE stays healthy across the cancel + the follow-up.
 * Captures run IDs, native session id, DB state, and SSE evidence. Self-cleaning:
 * deletes + API-verifies the Daytona sandbox at the end.
 *
 * Run:  BE_ORIGIN=http://localhost:3501 bun test/e2e/stop-resume-live.ts
 */
import postgres from "postgres";
import { deleteById } from "./soak/lib/daytona";

const BE = process.env.BE_ORIGIN ?? "http://localhost:3501";
const ORIGIN = "http://localhost:3200"; // dev org (anonymous)
const MODEL = process.env.STOP_MODEL ?? "claude-haiku-4-5";
const DB = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/useagent";
// A prompt that forces ONE long-running bash tool call (~120s) so we can cancel
// mid-flight. If Stop works, the run settles long before tick 40 and the output is
// partial.
const LONG_PROMPT =
  "Use the bash tool to run EXACTLY this one command and wait for it to finish, then say 'done': " +
  "`for i in $(seq 1 40); do echo tick $i; sleep 3; done`. Do NOT run any other command.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sql = postgres(DB, { max: 2 });
const checks: { name: string; ok: boolean; note?: string }[] = [];
const add = (name: string, ok: boolean, note?: string) => {
  checks.push({ name, ok, note });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${note ? ` - ${note}` : ""}`);
};

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function getRun(id: string) {
  const res = await fetch(`${BE}/api/runs/${id}`, { headers: { Origin: ORIGIN } });
  return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
}
async function dbRun(id: string) {
  const [r] = await sql`
    SELECT id, status, summary, thread_id, parent_run_id, engine, engine_session_id, sandbox_id,
           (SELECT count(*) FROM steps s WHERE s.run_id = runs.id) AS steps
    FROM runs WHERE id = ${id}`;
  return r as Record<string, unknown> | undefined;
}

// ── SSE health monitor on the thread ─────────────────────────────────────────
function watchThreadSSE(rootRunId: string) {
  const events: { type: string; runId?: string; status?: string }[] = [];
  const ctrl = new AbortController();
  let error: string | null = null;
  const done = (async () => {
    try {
      const res = await fetch(`${BE}/api/runs/${rootRunId}/thread-events`, {
        headers: { Origin: ORIGIN, accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        error = `SSE HTTP ${res.status}`;
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const f of frames) {
          const ev = /event: (.+)/.exec(f)?.[1]?.trim();
          const dataLine = /data: (.+)/.exec(f)?.[1];
          let parsed: Record<string, unknown> = {};
          try { parsed = dataLine ? JSON.parse(dataLine) : {}; } catch { /* keepalive */ }
          if (ev) events.push({ type: ev, runId: parsed.runId as string, status: parsed.status as string });
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) error = e instanceof Error ? e.message : String(e);
    }
  })();
  return { events, stop: () => { ctrl.abort(); return done; }, getError: () => error };
}

let sandboxIds = new Set<string>();
try {
  console.log(`\n=== #135 LIVE stop + resume (BE=${BE}, model=${MODEL}) ===\n`);

  // 1. Start the long run.
  const started = await post("/api/runs", { prompt: LONG_PROMPT, engine: "opencode", model: MODEL });
  const runId1 = started.body?.id as string | undefined;
  add("run 1 accepted", (started.status === 200 || started.status === 201) && !!runId1, `HTTP ${started.status} id=${runId1?.slice(0, 8)}`);
  if (!runId1) throw new Error("no run id");

  // Open the thread SSE (root = runId1) and keep it running across the whole test.
  const sse = watchThreadSSE(runId1);

  // 2. Wait until the run is RUNNING and has entered the bash tool call.
  const startWait = Date.now();
  let inToolCall = false;
  for (let i = 0; i < 120; i++) {
    const r = await getRun(runId1);
    const steps = (r?.steps as { kind?: string; label?: string; chip?: string }[]) ?? [];
    const cmd = steps.find((s) => s.kind === "command" || s.chip === "bash");
    if (r?.sandbox_id) sandboxIds.add(r.sandbox_id as string);
    if (r?.status === "running" && cmd) { inToolCall = true; break; }
    if (r?.status === "failed" || r?.status === "completed") {
      add("run reached the bash tool call before settling", false, `settled early: ${r?.status} (${r?.summary})`);
      throw new Error(`run settled before tool call: ${r?.status}`);
    }
    await sleep(2000);
  }
  const toBashMs = Date.now() - startWait;
  add("run entered the bash tool call (running)", inToolCall, `after ${Math.round(toBashMs / 1000)}s`);
  // Let the bash run a few seconds so the cancel is genuinely MID-flight.
  await sleep(6000);

  // 3. Cancel mid-flight.
  const cancelAt = Date.now();
  const cancel = await post(`/api/runs/${runId1}/cancel`, {});
  add("cancel accepted (durable)", cancel.status === 200 || cancel.status === 202, `HTTP ${cancel.status}`);

  // 4. Poll until settled.
  let settled: Record<string, unknown> | null = null;
  for (let i = 0; i < 60; i++) {
    const r = await getRun(runId1);
    if (r && (r.status === "failed" || r.status === "completed" || r.status === "cancelled")) { settled = r; break; }
    await sleep(1000);
  }
  const stopLatencyMs = Date.now() - cancelAt;
  add("run settled after cancel", !!settled, `status=${settled?.status} in ${Math.round(stopLatencyMs / 1000)}s`);
  add('durable status is "Stopped by user"', settled?.summary === "Stopped by user", `summary="${settled?.summary}"`);
  // Mid-flight proof: the bash needed ~120s; if the run settled far sooner, it was aborted.
  const totalMs = Date.now() - startWait;
  add("aborted mid-flight (settled << 120s bash duration)", totalMs < 90_000, `${Math.round(totalMs / 1000)}s total`);
  // Partial output: the bash never reached the final tick.
  const d1 = await dbRun(runId1);
  const stepsJson = JSON.stringify(await sql`SELECT code_json FROM steps WHERE run_id = ${runId1}`);
  add("bash output is partial (never reached tick 40)", !stepsJson.includes("tick 40"), "no final tick in steps");
  if (d1?.sandbox_id) sandboxIds.add(d1.sandbox_id as string);
  const sessionId = d1?.engine_session_id as string | undefined;

  // 5. SSE health across the cancel: the stream stayed open (no error) and delivered
  // the run's lifecycle including a terminal `done` (the thread-events terminal event).
  await sleep(1500);
  const sawTerminal = sse.events.some((e) => e.type === "done") || sse.events.some((e) => e.type === "run");
  add("thread SSE healthy through cancel (no error)", sse.getError() === null, sse.getError() ?? "ok");
  add("thread SSE delivered lifecycle + terminal", sawTerminal, `${sse.events.length} events: ${[...new Set(sse.events.map((e) => e.type))].join(",")}`);

  // 6. RESUME: a follow-up in the SAME thread (parent_run_id) - should reuse the thread + native session.
  const follow = await post("/api/runs", {
    prompt: "Reply with exactly the text: resumed-ok. Do not run any tools.",
    engine: "opencode",
    model: MODEL,
    parent_run_id: runId1,
  });
  const runId2 = follow.body?.id as string | undefined;
  add("follow-up run accepted", (follow.status === 200 || follow.status === 201) && !!runId2, `HTTP ${follow.status} id=${runId2?.slice(0, 8)}`);
  if (!runId2) throw new Error("no follow-up id");

  let d2: Record<string, unknown> | undefined;
  for (let i = 0; i < 120; i++) {
    d2 = await dbRun(runId2);
    if (d2?.sandbox_id) sandboxIds.add(d2.sandbox_id as string);
    if (d2 && (d2.status === "completed" || d2.status === "failed")) break;
    await sleep(2000);
  }
  add("follow-up completed", d2?.status === "completed", `status=${d2?.status}`);
  add("follow-up joined the SAME thread", d2?.thread_id === d1?.thread_id, `thread ${String(d2?.thread_id).slice(0, 8)}`);
  add("follow-up parent_run_id links to run 1", d2?.parent_run_id === runId1);
  add(
    "resumed the SAME native session (engine_session_id reused)",
    !!sessionId && d2?.engine_session_id === sessionId,
    `session=${String(sessionId).slice(0, 14)}`,
  );

  // 7. Reload/durability: the thread API returns BOTH turns settled (what a reload rebuilds from).
  const thr = await fetch(`${BE}/api/runs/${runId1}?thread=1`, { headers: { Origin: ORIGIN } });
  const thread = ((await thr.json().catch(() => ({}))) as { thread?: Record<string, unknown>[] }).thread ?? [];
  const bothSettled =
    thread.length >= 2 &&
    thread.every((r) => r.status === "completed" || r.status === "failed") &&
    thread.some((r) => r.id === runId1) &&
    thread.some((r) => r.id === runId2);
  add("reload durability: both turns present + settled in thread", bothSettled, `${thread.length} runs`);

  await sse.stop();

  console.log("\n=== EVIDENCE ===");
  console.log("run1 (stopped):", JSON.stringify(d1));
  console.log("run2 (resumed):", JSON.stringify(d2));
  console.log("native session id:", sessionId);
  console.log("SSE event types:", [...new Set(sse.events.map((e) => e.type))].join(", "), `(${sse.events.length} total)`);
  console.log("sandbox ids seen:", [...sandboxIds].join(", ") || "(none)");
} finally {
  // ── Daytona hygiene: delete + API-verify every sandbox this test touched ──────
  const ids = [...sandboxIds].filter(Boolean);
  if (ids.length) {
    console.log(`\n[cleanup] deleting ${ids.length} sandbox(es): ${ids.join(", ")}`);
    const res = await deleteById(ids).catch((e) => ({ deleted: [], failed: [{ id: "?", error: String(e) }] }));
    add("sandbox(es) deleted + verified gone", res.failed.length === 0, `deleted ${res.deleted.length}, failed ${res.failed.length}`);
  } else {
    add("no sandbox to clean", true);
  }
  await sql.end();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? "✅ PASS" : "❌ FAIL"} - ${checks.length - failed.length}/${checks.length} checks`);
  if (failed.length) console.log("FAILED:", failed.map((c) => c.name).join(" | "));
  process.exit(failed.length === 0 ? 0 : 1);
}
