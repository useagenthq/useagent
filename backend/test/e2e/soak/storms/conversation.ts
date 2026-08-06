/**
 * STORM (a) — conversation storms. The user's north star: "test my kick and
 * conversation 1000 times". A kick = POST a root run; a conversation = a chain of
 * replies queued behind it in the durable command mailbox. Two adversarial
 * shapes per cycle:
 *
 *   sequential — reply[i].parent = reply[i-1] (a real threaded conversation),
 *                each POST awaited so creation order is definite.
 *   burst      — all replies POSTed CONCURRENTLY with parent = root, so the
 *                mailbox's claim CAS is hammered by racing pumpThread calls.
 *
 * Invariants asserted per thread (from the DB, precisely):
 *   • no drops   — exactly kick + N replies runs exist, all `completed`.
 *   • no dupes   — every run has exactly ONE run.create command; ids distinct.
 *   • strict order — runs EXECUTE in mailbox order (commands by created_at,id);
 *                    for the sequential shape that equals the POST order.
 *   • one-in-flight — consecutive runs never overlap in wall-clock (each run's
 *                    last step precedes the next run's first step) — the
 *                    serialization guarantee a conversation depends on.
 *
 * Isolated stack, fresh throwaway DB, mock engine. Prints SOAK_RESULT and exits.
 */
import { Stack, waitFor } from "../lib/stack";
import { Recorder, rng } from "../lib/report";

const SEED = Number(process.env.SOAK_SEED ?? Date.now() % 2_000_000_000);
const THREADS = Number(process.env.SOAK_CONV_THREADS ?? 16);
const REPLIES = Number(process.env.SOAK_CONV_REPLIES ?? 6);
const PORT = Number(process.env.SOAK_PORT ?? 3516);
// Per-thread settle budget. Generous by default so heavy machine load (a busy dev
// fleet sharing the box) starving the mock worker doesn't false-fail a thread.
const SETTLE_MS = Number(process.env.SOAK_CONV_SETTLE_MS ?? 150_000);

const rec = new Recorder("conversation");
const rand = rng(SEED);

const stack = new Stack({
  db: `skynet_soak_conv_${PORT}`,
  port: PORT,
  stepDelayMs: 3, // fast; the storm's stress is queue ordering, not step timing
});

interface RunRow { id: string; status: string; parent_run_id: string | null; thread_id: string }
interface CmdRow { run_id: string; created_at: string; id: string }

/** Read a thread's runs + commands + step time-bounds straight from the DB. */
async function threadState(threadId: string): Promise<{
  runs: RunRow[];
  cmds: CmdRow[];
  bounds: Map<string, { start: number; end: number; steps: number }>;
  cmdCountByRun: Map<string, number>;
}> {
  const runs = (await stack.sql`select id, status, parent_run_id, thread_id from runs where thread_id = ${threadId}`) as unknown as RunRow[];
  const cmds = (await stack.sql`select run_id, created_at, id from commands where thread_id = ${threadId} and kind = 'run.create' order by created_at asc, id asc`) as unknown as CmdRow[];
  const stepRows = (await stack.sql`
    select run_id, min(created_at) as start_at, max(created_at) as end_at, count(*)::int as n
    from steps where run_id in ${stack.sql(runs.map((r) => r.id))} group by run_id`) as unknown as Array<{ run_id: string; start_at: string; end_at: string; n: number }>;
  const bounds = new Map<string, { start: number; end: number; steps: number }>();
  for (const s of stepRows) bounds.set(s.run_id, { start: new Date(s.start_at).getTime(), end: new Date(s.end_at).getTime(), steps: s.n });
  const cmdCountByRun = new Map<string, number>();
  for (const cmd of cmds) cmdCountByRun.set(cmd.run_id, (cmdCountByRun.get(cmd.run_id) ?? 0) + 1);
  return { runs, cmds, bounds, cmdCountByRun };
}

/** Assert every invariant for one finished thread. `postOrder` is the id sequence
 *  the client submitted (kick first); null for the burst shape (no defined order). */
async function assertThread(threadId: string, expectedRuns: number, postOrder: string[] | null, shape: string): Promise<void> {
  const { runs, cmds, bounds, cmdCountByRun } = await threadState(threadId);
  const ev = { seed: SEED, shape, threadId };

  rec.check(runs.length === expectedRuns, "no drops: run count", `${runs.length}/${expectedRuns} runs in thread`, { ...ev, got: runs.length, want: expectedRuns });
  const allCompleted = runs.every((r) => r.status === "completed");
  rec.check(allCompleted, "all runs completed", `statuses: ${runs.map((r) => r.status).join(",")}`, { ...ev, statuses: runs.map((r) => r.status) });

  // no dupes: one command per run, distinct run ids, command count == run count.
  const dupCmd = [...cmdCountByRun.entries()].filter(([, n]) => n !== 1);
  rec.check(dupCmd.length === 0, "no dupes: exactly one command per run", `${dupCmd.length} runs with ≠1 command`, { ...ev, dupCmd });
  rec.check(cmds.length === expectedRuns, "no dupes: command count", `${cmds.length}/${expectedRuns} commands`, { ...ev, got: cmds.length });

  // strict order: execution order (by step start) == mailbox order (commands).
  const mailboxOrder = cmds.map((c) => c.run_id);
  const withStart = runs.filter((r) => bounds.has(r.id)).map((r) => ({ id: r.id, start: bounds.get(r.id)!.start }));
  withStart.sort((a, b) => a.start - b.start);
  const execOrder = withStart.map((r) => r.id);
  const orderMatches = execOrder.length === mailboxOrder.length && execOrder.every((id, i) => id === mailboxOrder[i]);
  rec.check(orderMatches, "strict order: execution == mailbox order", orderMatches ? "" : `exec ${execOrder.join(",").slice(0, 80)} vs mailbox ${mailboxOrder.join(",").slice(0, 80)}`, { ...ev, execOrder, mailboxOrder });

  // For the sequential shape the mailbox order MUST equal the POST order.
  if (postOrder) {
    const postMatches = mailboxOrder.length === postOrder.length && mailboxOrder.every((id, i) => id === postOrder[i]);
    rec.check(postMatches, "strict order: mailbox == POST order (sequential)", postMatches ? "" : "diverged", { ...ev, postOrder, mailboxOrder });
  }

  // one-in-flight: consecutive runs (in exec order) never overlap.
  let overlaps = 0;
  for (let i = 1; i < execOrder.length; i++) {
    const prev = bounds.get(execOrder[i - 1]!)!;
    const cur = bounds.get(execOrder[i]!)!;
    if (prev.end > cur.start) overlaps++;
  }
  rec.check(overlaps === 0, "one-in-flight: no overlapping runs", `${overlaps} overlaps`, { ...ev, overlaps });
  rec.bump("threads");
  rec.bump("runs", runs.length);
}

async function sequentialThread(i: number): Promise<void> {
  const kickPrompt = `soak-kick-seq-${SEED}-${i}`;
  const kick = await stack.postRun({ prompt: kickPrompt, engine: "mock" });
  if (kick.status !== 201 || !kick.id) {
    rec.check(false, "kick POST 201", `status=${kick.status} err=${kick.error}`, { seed: SEED, shape: "sequential", i });
    return;
  }
  const root = kick.id;
  const postOrder = [root];
  let parent = root;
  for (let r = 0; r < REPLIES; r++) {
    const reply = await stack.postRun({ prompt: `soak-reply-${SEED}-${i}-${r}`, engine: "mock", parent_run_id: parent });
    if (reply.status !== 201 || !reply.id) {
      rec.check(false, "reply POST 201", `status=${reply.status} err=${reply.error}`, { seed: SEED, shape: "sequential", i, r });
      return;
    }
    postOrder.push(reply.id);
    parent = reply.id; // true chain — reply follows the previous reply
  }
  const want = REPLIES + 1;
  const done = await waitFor(async () => Number((await stack.sql`select count(*)::int as n from runs where thread_id = ${root} and status in ('completed','failed')`)[0]!.n) === want, SETTLE_MS);
  rec.check(done, "thread reached terminal", "timed out waiting for all runs to settle", { seed: SEED, shape: "sequential", i, root });
  if (done) await assertThread(root, want, postOrder, "sequential");
}

async function burstThread(i: number): Promise<void> {
  const kick = await stack.postRun({ prompt: `soak-kick-burst-${SEED}-${i}`, engine: "mock" });
  if (kick.status !== 201 || !kick.id) {
    rec.check(false, "kick POST 201", `status=${kick.status}`, { seed: SEED, shape: "burst", i });
    return;
  }
  const root = kick.id;
  // Fire every reply CONCURRENTLY — races the mailbox claim CAS + pumpThread.
  const results = await Promise.all(
    Array.from({ length: REPLIES }, (_, r) => stack.postRun({ prompt: `soak-burst-${SEED}-${i}-${r}`, engine: "mock", parent_run_id: root })),
  );
  const created = results.filter((x) => x.status === 201 && x.id).length;
  rec.check(created === REPLIES, "all burst replies accepted", `${created}/${REPLIES} created`, { seed: SEED, shape: "burst", i, created });
  const want = REPLIES + 1;
  const done = await waitFor(async () => Number((await stack.sql`select count(*)::int as n from runs where thread_id = ${root} and status in ('completed','failed')`)[0]!.n) === want, SETTLE_MS);
  rec.check(done, "thread reached terminal", "timed out", { seed: SEED, shape: "burst", i, root });
  if (done) await assertThread(root, want, null, "burst");
}

async function main(): Promise<void> {
  const t0 = Date.now();
  await stack.recreateDb();
  await stack.start("conv");
  try {
    // Interleave shapes so both run against the same warmed stack; a little
    // concurrency across threads (different threads dispatch independently).
    for (let i = 0; i < THREADS; i++) {
      const batch: Promise<void>[] = [sequentialThread(i), burstThread(i)];
      // Occasionally add a second concurrent pair to widen cross-thread pressure.
      if (rand() < 0.5) batch.push(sequentialThread(i + THREADS));
      await Promise.all(batch);
    }
  } catch (err) {
    rec.check(false, "harness error", err instanceof Error ? err.message : String(err), { seed: SEED });
  } finally {
    await stack.teardown();
  }
  rec.emit(Date.now() - t0, rec.stats.threads ?? 0);
}

await main();
