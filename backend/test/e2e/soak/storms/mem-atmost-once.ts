/**
 * STORM (f) — memory outbox AT-MOST-ONCE on crash. The team-memory capture outbox
 * has a deliberately DIFFERENT crash policy from Slack: /v3/conversation/add has no
 * idempotency key, so a re-delivery would create a DUPLICATE L0 turn. A row
 * orphaned in `delivering` by a crash is therefore NEVER auto-reset to pending
 * (no resetStuckDelivering) — it awaits manual inspection. This storm proves that
 * invariant end-to-end, the gap the crash storm (which tests Slack's at-LEAST-once)
 * leaves open. It's the mandate's "outboxes exactly-once-on-crash" for the memory lane.
 *
 * Per cycle: a completed mock run enqueues a capture → the delivery loop claims it
 * to `delivering` and POSTs to a HANGING memory receiver (held open) → SIGKILL the
 * backend mid-delivery → reboot. Assertions:
 *   • the orphaned row stays `delivering` after reboot (NOT reset, NOT delivered);
 *   • the receiver gets NO second add for that capture (no auto-retry → no dup turn);
 *   • the capture is never silently dropped (the row still exists).
 */
import { Stack, waitFor, sleep } from "../lib/stack";
import { Recorder, rng } from "../lib/report";

const SEED = Number(process.env.SOAK_SEED ?? Date.now() % 2_000_000_000);
const CYCLES = Number(process.env.SOAK_MEMCRASH_CYCLES ?? 6);
const PORT = Number(process.env.SOAK_PORT ?? 3519);
const MEM_PORT = Number(process.env.SOAK_MEM_PORT ?? 3539);

const rec = new Recorder("mem-atmost-once");
const rand = rng(SEED);

const stack = new Stack({
  db: `skynet_soak_memcrash_${PORT}`,
  port: PORT,
  memPort: MEM_PORT,
  stepDelayMs: 3,
  extraEnv: { MEMORY_OUTBOX_TICK_MS: "150" }, // claim the pending row promptly
});

/** Add-attempts the receiver saw for a capture, identified by its unique prompt. */
function addsFor(prompt: string): number {
  return stack.mem!.hits.filter((h) => h.path === "/v3/conversation/add" && JSON.stringify(h.body?.messages ?? []).includes(prompt)).length;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  await stack.recreateDb();
  // The memory gateway HANGS on add: the delivery attempt claims the row to
  // `delivering`, POSTs, and blocks — so a SIGKILL orphans it mid-flight.
  stack.mem!.setFault((_n, hit) => (hit.path === "/v3/conversation/add" ? { status: 200, body: { code: 0 }, delayMs: 60_000 } : null));
  stack.startReceivers();
  await stack.start("memcrash-boot");
  try {
    for (let i = 0; i < CYCLES; i++) {
      const ev: Record<string, unknown> = { seed: SEED, cycle: i };
      const prompt = `memcrash-${SEED}-${i}-${Math.floor(rand() * 1e6)}`;
      const kick = await stack.postRun({ prompt, engine: "mock" });
      if (kick.status !== 201 || !kick.id) { rec.check(false, "run accepted", `status=${kick.status}`, ev); continue; }
      const runId = kick.id;

      // Run completes → capture enqueued (pending) → delivery loop claims it to
      // `delivering` and POSTs to the hanging receiver. Gate on the receiver having
      // ACTUALLY received the POST (addsFor≥1) — the row flips to 'delivering' in
      // claimDue BEFORE the POST is sent, so waiting only on state races the send.
      const inFlight = await waitFor(async () => {
        const st = (await stack.sql`select state from memory_outbox where run_id = ${runId}`)[0]?.state;
        return st === "delivering" && addsFor(prompt) >= 1;
      }, 20_000);
      rec.check(inFlight, "capture POST in-flight to gateway (delivering + received)", "never reached in-flight", ev);
      if (!inFlight) continue;
      const addsBeforeKill = addsFor(prompt);
      rec.check(addsBeforeKill === 1, "exactly one add attempt in flight at kill", `${addsBeforeKill}`, { ...ev, addsBeforeKill });

      // SIGKILL mid-delivery, reboot.
      await stack.kill();
      rec.bump("kills");
      await stack.start(`memcrash-restart-${i}`);

      // The orphaned row must stay `delivering` — memory has NO resetStuckDelivering.
      // Give the reboot's delivery loop several ticks to (wrongly) grab it if buggy.
      await sleep(1200);
      const stateAfter = (await stack.sql`select state from memory_outbox where run_id = ${runId}`)[0]?.state;
      rec.check(stateAfter === "delivering", "orphaned capture stays 'delivering' after reboot (never auto-reset)", `state=${stateAfter}`, { ...ev, stateAfter });
      rec.check(stateAfter !== undefined, "orphaned capture row not lost", `state=${stateAfter}`, ev);

      // No second add attempt after reboot → no duplicate team-memory turn.
      const addsAfter = addsFor(prompt);
      rec.check(addsAfter <= 1, "no auto-retry after crash (at-most-once: ≤1 add ever)", `${addsAfter} adds total`, { ...ev, addsAfter });
      rec.bump("cycles");
    }
  } catch (err) {
    rec.check(false, "harness error", err instanceof Error ? (err.stack ?? err.message) : String(err), { seed: SEED });
  } finally {
    await stack.teardown();
  }
  rec.emit(Date.now() - t0, rec.stats.cycles ?? 0);
}

await main();
