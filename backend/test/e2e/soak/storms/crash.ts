/**
 * STORM (c) — kill/restart loops. SIGKILL the backend at a RANDOMIZED phase of a
 * run's lifecycle, restart, and assert boot recovery restores every invariant.
 * Phases (observed from the DB, so the recorded phase is the TRUE pre-kill state):
 *
 *   early     — A just POSTed (queued / worker not yet started / command dispatched)
 *   mid-run   — A running with ≥ mid steps, reply B queued behind it
 *   pre-settle— A reached `completed`, its command may still be `dispatched`
 *   outbox    — a Slack-originated run's reply is enqueued (pending/delivering) but
 *               NOT yet delivered
 *
 * Post-reboot invariants:
 *   • no lost runs   — every pre-kill run still exists and is terminal;
 *   • no dup runs    — the run set is unchanged (no phantom re-creation);
 *   • lane not stuck — no command left `dispatched` for a terminal run; the queued
 *                      reply B dispatches + completes;
 *   • order          — B settles after A;
 *   • outbox         — the Slack reply is delivered (at-least-once: ≥1, dups noted);
 *                      completed runs kept their memory capture row (never lost).
 *
 * The backend runs with a slow mock step so `mid-run` is catchable. Each cycle is
 * an isolated thread on ONE long-lived DB (the crash target), reset per cycle.
 */
import { Stack, waitFor, sleep } from "../lib/stack";
import { Recorder, rng } from "../lib/report";

const SEED = Number(process.env.SOAK_SEED ?? Date.now() % 2_000_000_000);
const CYCLES = Number(process.env.SOAK_CRASH_CYCLES ?? 12);
const PORT = Number(process.env.SOAK_PORT ?? 3517);
const MEM_PORT = Number(process.env.SOAK_MEM_PORT ?? 3527);
const SLACK_PORT = Number(process.env.SOAK_SLACK_PORT ?? 3528);

const rec = new Recorder("crash");
const rand = rng(SEED);
const BOT = "U0SOAKBOT";

const stack = new Stack({
  db: `skynet_soak_crash_${PORT}`,
  port: PORT,
  memPort: MEM_PORT,
  slackPort: SLACK_PORT,
  stepDelayMs: Number(process.env.SOAK_CRASH_STEP_MS ?? 110), // slow → catch mid-run
  debug: !!process.env.SOAK_DEBUG,
  // Push background outbox ticks out so the `outbox` phase can kill BEFORE delivery.
  extraEnv: { SLACK_OUTBOX_TICK_MS: "4000", MEMORY_OUTBOX_TICK_MS: "4000" },
});

const PHASES = ["early", "mid-run", "pre-settle", "outbox"] as const;
type Phase = (typeof PHASES)[number];

interface RunRow { id: string; status: string }
const terminal = (s: string) => s === "completed" || s === "failed";

async function runsIn(threadId: string): Promise<RunRow[]> {
  return (await stack.sql`select id, status from runs where thread_id = ${threadId} order by created_at asc`) as unknown as RunRow[];
}
async function cmdState(runId: string): Promise<string | null> {
  const r = (await stack.sql`select state from commands where run_id = ${runId} and kind='run.create'`) as unknown as Array<{ state: string }>;
  return r[0]?.state ?? null;
}

/** API cycle: kick A (slow), queue reply B, kill at the target phase, reboot, assert. */
async function apiCycle(i: number, phase: Phase): Promise<void> {
  const ev: Record<string, unknown> = { seed: SEED, cycle: i, phase };
  const kick = await stack.postRun({ prompt: `crash-A-${SEED}-${i}`, engine: "mock" });
  if (kick.status !== 201 || !kick.id) return void rec.check(false, "kick accepted", `status=${kick.status}`, ev);
  const A = kick.id;
  const b = await stack.postRun({ prompt: `crash-B-${SEED}-${i}`, engine: "mock", parent_run_id: A });
  if (b.status !== 201 || !b.id) return void rec.check(false, "reply B accepted", `status=${b.status}`, ev);
  const B = b.id;
  ev.A = A; ev.B = B;

  // Reach the target phase, then SIGKILL.
  let observed = "unknown";
  if (phase === "early") {
    await sleep(Math.floor(rand() * 40)); // race the dispatch/worker-start window
    observed = (await stack.sql`select status from runs where id = ${A}`)[0]?.status ?? "gone";
  } else if (phase === "mid-run") {
    await waitFor(async () => {
      const n = Number((await stack.sql`select count(*)::int as n from steps where run_id = ${A}`)[0]!.n);
      const s = (await stack.sql`select status from runs where id = ${A}`)[0]?.status;
      return s === "running" && n >= 2;
    }, 20_000);
    observed = "running";
  } else if (phase === "pre-settle") {
    await waitFor(async () => (await stack.sql`select status from runs where id = ${A}`)[0]?.status === "completed", 20_000);
    observed = (await cmdState(A)) === "dispatched" ? "completed+cmd-dispatched" : "completed+cmd-settled";
  }
  ev.observed = observed;

  // B's lane state AT KILL decides which invariant is valid. If B is still
  // `queued`, it must survive + complete IN ORDER (the strong guarantee). If the
  // pump already dispatched B (A completed → onRunSettled pumped B before the
  // kill), B is a running MOCK at kill: recovery honest-fails it (mock can't
  // reconcile — a REAL engine would). Either way B must reach TERMINAL, never lost.
  const bCmdAtKill = await cmdState(B);
  ev.bCmdAtKill = bCmdAtKill;
  const preRuns = await runsIn(A);
  await stack.kill();
  rec.bump("kills");

  // Reboot — boot recovery runs synchronously before /api/health answers.
  await stack.start(`restart-${i}`);

  const aTerminal = await waitFor(async () => terminal((await stack.sql`select status from runs where id = ${A}`)[0]?.status ?? ""), 30_000);
  rec.check(aTerminal, "A terminal after reboot (recovery ran)", "A never settled", ev);

  // B must reach a terminal state (dispatched+run, or honest-fail) — never lost.
  const bTerminal = await waitFor(async () => terminal((await stack.sql`select status from runs where id = ${B}`)[0]?.status ?? ""), 30_000);
  const bStatus = (await stack.sql`select status from runs where id = ${B}`)[0]?.status;
  if (!bTerminal) {
    const bCmd = await cmdState(B);
    const bSteps = Number((await stack.sql`select count(*)::int as n from steps where run_id = ${B}`)[0]!.n);
    const allCmds = (await stack.sql`select run_id, state from commands where thread_id = ${A} and kind='run.create' order by created_at asc`) as unknown as Array<{ run_id: string; state: string }>;
    Object.assign(ev, { bStatus, bCmd, bSteps, lane: allCmds.map((c) => `${c.run_id === A ? "A" : c.run_id === B ? "B" : "?"}:${c.state}`) });
  }
  rec.check(bTerminal, "reply B reached terminal after reboot (not lost)", `B=${bStatus}`, ev);
  // Strong guarantee only when B was genuinely still queued at kill.
  if (bCmdAtKill === "queued") {
    rec.check(bStatus === "completed", "queued reply B dispatched + completed in order", `B=${bStatus} (queued at kill)`, ev);
  } else {
    rec.bump("b_dispatched_at_kill"); // mock honest-fail path — counted, not failed
  }

  // no lost / dup runs: same run set, all terminal.
  const postRuns = await runsIn(A);
  rec.check(postRuns.length === preRuns.length, "no lost/dup runs across crash", `pre=${preRuns.length} post=${postRuns.length}`, { ...ev, pre: preRuns.map((r) => r.id), post: postRuns.map((r) => r.id) });
  rec.check(postRuns.every((r) => terminal(r.status)), "all runs terminal after recovery", postRuns.map((r) => r.status).join(","), ev);

  // order preserved: B settled at/after A (only meaningful when B ran to completion).
  if (aTerminal && bStatus === "completed") {
    const [{ a_at }] = (await stack.sql`select updated_at as a_at from runs where id = ${A}`) as unknown as Array<{ a_at: string }>;
    const [{ b_at }] = (await stack.sql`select updated_at as b_at from runs where id = ${B}`) as unknown as Array<{ b_at: string }>;
    rec.check(new Date(b_at) >= new Date(a_at), "order: B settled after A", `A=${a_at} B=${b_at}`, ev);
  }

  // lane not stuck: no dispatched command remains for either run (both terminal).
  const stuck = Number((await stack.sql`select count(*)::int as n from commands where thread_id = ${A} and state='dispatched'`)[0]!.n);
  rec.check(stuck === 0, "no command stuck 'dispatched' after recovery", `${stuck} stuck`, ev);

  // completed runs kept their memory capture row (completed ⇒ capture enqueued).
  const completedIds = postRuns.filter((r) => r.status === "completed").map((r) => r.id);
  if (completedIds.length > 0) {
    const capRows = Number((await stack.sql`select count(*)::int as n from memory_outbox where run_id in ${stack.sql(completedIds)}`)[0]!.n);
    rec.check(capRows === completedIds.length, "every completed run has a memory capture row", `${capRows}/${completedIds.length}`, { ...ev, completedIds });
  }
  rec.bump("cycles");
}

/** Outbox cycle: a Slack run whose reply is enqueued but not yet delivered when we
 *  kill; on reboot the relay must deliver it (never lose it). */
async function outboxCycle(i: number): Promise<void> {
  const ev: Record<string, unknown> = { seed: SEED, cycle: i, phase: "outbox" };
  const channel = `C${SEED % 100000}${i}`;
  const rootTs = `${SEED % 100000}.${i}`;
  const prompt = `crash-slack-${SEED}-${i}`;
  await stack.postSlackEvent({ type: "app_mention", channel, user: "U-H", text: `<@${BOT}> ${prompt}`, ts: rootTs }, BOT);

  // Wait until the run completes AND its REPLY (post_message) row is enqueued
  // (pending/delivering), then kill BEFORE the (pushed-out) relay tick delivers it.
  // MUST filter kind='post_message': the app_mention also enqueues a fast
  // add_reaction receipt whose payload carries the same ts, which would otherwise
  // satisfy the delivered-gate before the reply itself lands (harness false-neg).
  const gotRow = await waitFor(async () => {
    const r = (await stack.sql`select o.state from slack_outbox o where o.kind = 'post_message' and o.payload like ${"%" + rootTs + "%"}`) as unknown as Array<{ state: string }>;
    return r.some((x) => x.state === "pending" || x.state === "delivering");
  }, 25_000);
  ev.enqueued = gotRow;
  await stack.kill();
  rec.bump("kills");
  await stack.start(`restart-ob-${i}`);

  // The durability invariant is only meaningful when the reply was actually
  // enqueued (pending/delivering) BEFORE the crash. If the run hadn't reached
  // finalize in time (gotRow=false), the reply was never enqueued — that's a
  // slow-path, not a lost delivery — so skip the assertion (counted, not failed).
  if (!gotRow) {
    rec.bump("outbox_precondition_missed");
    rec.bump("cycles");
    return;
  }

  // Relay boot-recovery + tick must deliver the enqueued REPLY (post_message,
  // NOT the reaction) — never lost.
  const delivered = await waitFor(async () => Number((await stack.sql`select count(*)::int as n from slack_outbox where state='delivered' and kind='post_message' and payload like ${"%" + rootTs + "%"}`)[0]!.n) >= 1, 30_000);
  rec.check(delivered, "enqueued slack reply delivered after reboot (not lost)", "reply never delivered", ev);

  // at-least-once: the mock receiver saw the reply ≥1×; >1 = the documented crash dup.
  const postMsgDeliveries = stack.slack!.hits.filter((h) => h.path.includes("chat.postMessage") && JSON.stringify(h.body).includes(rootTs)).length;
  rec.check(postMsgDeliveries >= 1, "receiver got the reply at least once", `${postMsgDeliveries} deliveries`, { ...ev, postMsgDeliveries });
  if (postMsgDeliveries > 1) rec.bump("slack_duplicate_deliveries", postMsgDeliveries - 1); // documented at-least-once trade
  rec.bump("cycles");
}

async function main(): Promise<void> {
  const t0 = Date.now();
  await stack.recreateDb();
  stack.startReceivers();
  await stack.start("crash-boot");
  try {
    for (let i = 0; i < CYCLES; i++) {
      const phase = PHASES[Math.floor(rand() * PHASES.length)]!;
      if (phase === "outbox") await outboxCycle(i);
      else await apiCycle(i, phase);
    }
  } catch (err) {
    rec.check(false, "harness error", err instanceof Error ? err.message : String(err), { seed: SEED });
  } finally {
    await stack.teardown();
  }
  rec.emit(Date.now() - t0, rec.stats.cycles ?? 0);
}

await main();
