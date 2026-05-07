/**
 * STORM (b) — idempotency storms. Per round, fire C CONCURRENT POST /api/runs
 * with the SAME Idempotency-Key + payload and assert the durable command lane
 * collapses them to EXACTLY ONE run (the (org, key) partial-unique index + the
 * accept-time replay classifier). Also probes the conflict path: the same key
 * with a DIFFERENT payload must 409, never silently start new work.
 *
 * Invariants per round:
 *   • exactly one run + one command exist for the key (no duplicate work);
 *   • every 2xx response returns that SAME run id;
 *   • exactly one 201 (the winner); the rest are 200 replays;
 *   • no 5xx / unexpected status;
 *   • a mismatched-payload replay under the key → 409.
 */
import { Stack } from "../lib/stack";
import { Recorder } from "../lib/report";

const SEED = Number(process.env.SOAK_SEED ?? Date.now() % 2_000_000_000);
const ROUNDS = Number(process.env.SOAK_IDEM_ROUNDS ?? 24);
const CONC = Number(process.env.SOAK_IDEM_CONCURRENCY ?? 50);
const PORT = Number(process.env.SOAK_PORT ?? 3516);

const rec = new Recorder("idempotency");
const stack = new Stack({ db: `skynet_soak_idem_${PORT}`, port: PORT, stepDelayMs: 2 });

async function round(i: number): Promise<void> {
  const key = `soak-idem-${SEED}-${i}`;
  const body = { prompt: `idem body ${SEED}-${i}`, engine: "mock" };
  const ev = { seed: SEED, round: i, key };

  // C concurrent same-key POSTs.
  const responses = await Promise.all(
    Array.from({ length: CONC }, () => stack.postRun(body, { "Idempotency-Key": key })),
  );
  const ids = new Set(responses.filter((r) => r.id).map((r) => r.id!));
  const status201 = responses.filter((r) => r.status === 201).length;
  const status200 = responses.filter((r) => r.status === 200).length;
  const status5xx = responses.filter((r) => r.status >= 500).length;
  const otherStatus = responses.filter((r) => r.status !== 200 && r.status !== 201).length;

  // DB truth: one command for the key, one run.
  const cmdRows = (await stack.sql`select run_id from commands where idempotency_key = ${key}`) as unknown as Array<{ run_id: string }>;
  const runId = cmdRows[0]?.run_id;
  const runCount = runId ? Number((await stack.sql`select count(*)::int as n from runs where id = ${runId}`)[0]!.n) : 0;

  rec.check(cmdRows.length === 1, "exactly one command for key", `${cmdRows.length} commands`, { ...ev, cmds: cmdRows.length });
  rec.check(runCount === 1, "exactly one run for key", `${runCount} runs`, { ...ev, runCount });
  rec.check(ids.size === 1, "all responses share one run id", `${ids.size} distinct ids`, { ...ev, distinct: ids.size });
  rec.check(runId !== undefined && ids.has(runId), "responses match the durable run id", `db=${runId} resp=${[...ids][0]}`, { ...ev, runId, respId: [...ids][0] });
  rec.check(status201 === 1, "exactly one 201 (single winner)", `${status201} 201s`, { ...ev, status201 });
  rec.check(status200 === CONC - 1, "the rest are 200 replays", `${status200} 200s of ${CONC - 1} expected`, { ...ev, status200 });
  rec.check(status5xx === 0, "no 5xx under concurrent same-key", `${status5xx} 5xx`, { ...ev, status5xx });
  rec.check(otherStatus === 0, "no unexpected status codes", `${otherStatus} unexpected`, { ...ev, statuses: responses.map((r) => r.status) });

  // Conflict: same key, different payload → 409, no new run.
  const conflict = await stack.postRun({ prompt: `DIFFERENT ${SEED}-${i}`, engine: "mock" }, { "Idempotency-Key": key });
  rec.check(conflict.status === 409, "mismatched payload under key → 409", `status=${conflict.status}`, { ...ev, conflictStatus: conflict.status });
  const runCountAfter = runId ? Number((await stack.sql`select count(*)::int as n from runs where id = ${runId}`)[0]!.n) : 0;
  const totalRunsForKey = (await stack.sql`select count(*)::int as n from commands where idempotency_key = ${key}`) as unknown as Array<{ n: number }>;
  rec.check(Number(totalRunsForKey[0]!.n) === 1, "conflict created no extra command", `${totalRunsForKey[0]!.n} commands after conflict`, { ...ev });
  void runCountAfter;

  rec.bump("rounds");
  rec.bump("posts", CONC + 1);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  await stack.recreateDb();
  await stack.start("idem");
  try {
    for (let i = 0; i < ROUNDS; i++) await round(i);
  } catch (err) {
    rec.check(false, "harness error", err instanceof Error ? err.message : String(err), { seed: SEED });
  } finally {
    await stack.teardown();
  }
  rec.emit(Date.now() - t0, rec.stats.rounds ?? 0);
}

await main();
