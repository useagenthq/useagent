/**
 * STORM (d) — outbox floods. Enqueue a flood of Slack + memory deliveries, inject
 * 429/500/permanent faults, and assert every row reaches a terminal state
 * (delivered OR dead-lettered) with ZERO duplicate successful deliveries — and
 * nothing is silently lost.
 *
 * In-process: drives the REAL outbox modules directly (src/slack/outbox,
 * src/memory/capture-outbox). Slack faults via setSlackClientForTest; memory
 * faults via a flaky mock receiver at MEMORY_API_URL. Between delivery waves the
 * pending rows' next_attempt_at is fast-forwarded to now() so the retry→dead
 * machinery converges without waiting out the real 30s/exponential backoff.
 *
 * Invariants:
 *   • no stuck rows   — 0 pending/delivering after draining;
 *   • no loss         — delivered + dead == enqueued (both outboxes);
 *   • exactly-once    — each delivered row succeeded exactly once at the receiver
 *                       (Slack: at-least-once with 0 crashes ⇒ exactly-once here;
 *                        memory: at-most-once);
 *   • fault honored   — forced-permanent Slack rows dead-letter; forced-fail
 *                       memory rows dead-letter after maxAttempts; neither delivers.
 */
import { recreateDb, dropDb, sleep } from "../lib/inproc";
import { MockReceiver } from "../lib/stack";
import { Recorder, rng } from "../lib/report";

const SEED = Number(process.env.SOAK_SEED ?? Date.now() % 2_000_000_000);
const N_SLACK = Number(process.env.SOAK_OUTBOX_SLACK ?? 500);
const N_MEM = Number(process.env.SOAK_OUTBOX_MEM ?? 500);
const MEM_PORT = Number(process.env.SOAK_MEM_PORT ?? 3529);
const DB = `skynet_soak_outbox_${MEM_PORT}`;

const rec = new Recorder("outbox");
const rand = rng(SEED);

// env BEFORE any src import.
process.env.DATABASE_URL = `postgres://postgres@localhost:5432/${DB}`;
process.env.PORT = String(Number(process.env.SOAK_PORT ?? 3516) + 40);
process.env.SLACK_BOT_TOKEN = "xoxb-soak";
process.env.SLACK_SIGNING_SECRET = "soak";
process.env.SLACK_API_URL = "http://localhost:1"; // never used — client is overridden
process.env.MEMORY_API_URL = `http://localhost:${MEM_PORT}`;
process.env.MEMORY_API_KEY = "soak";
process.env.MEMORY_TEAM_ID = "skynet";
process.env.MEMORY_AGENT_ID = "skynet-backend";
process.env.MEMORY_USER_ID = "skynet";
process.env.SLACK_OUTBOX_TICK_MS = "3600000";
process.env.SLACK_OUTBOX_BASE_MS = "5";
process.env.MEMORY_OUTBOX_TICK_MS = "3600000";
delete process.env.OPENROUTER_API_KEY;

// memory fault receiver: forced-fail prompts always 500; else seeded 500/429/ok.
let memSuccessByPrompt = new Map<string, number>();
const memRecv = new MockReceiver(MEM_PORT, (n, hit) => {
  const prompt = String((hit.body?.messages ?? []).find((m: any) => m.role === "user")?.content ?? "");
  if (prompt.includes("hardfail")) return { status: 500, body: { code: 1 } };
  const r = rng(SEED ^ (n * 2654435761))();
  if (r < 0.18) return { status: 500, body: { code: 1 } };
  if (r < 0.24) return { status: 429, body: { code: 1 }, headers: { "retry-after": "0" } };
  return null; // success
}, (hit) => {
  const prompt = String((hit.body?.messages ?? []).find((m: any) => m.role === "user")?.content ?? "");
  memSuccessByPrompt.set(prompt, (memSuccessByPrompt.get(prompt) ?? 0) + 1);
  return { code: 0, data: {} };
});

async function main(): Promise<void> {
  const t0 = Date.now();
  await recreateDb(DB);
  memRecv.start();

  const { db, client } = await import("../../../../src/db/client");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  await migrate(db, { migrationsFolder: `${new URL("../../../..", import.meta.url).pathname}/drizzle` });

  const { enqueuePostMessage, processDue, getSlackOutbox } = await import("../../../../src/slack/outbox");
  const { enqueueCapture, deliverDueCaptures } = await import("../../../../src/memory/capture-outbox");
  const { setSlackClientForTest } = await import("../../../../src/slack/client");
  const { sql } = await import("drizzle-orm");

  // Slack fault client: forced-permanent keys always permanent; else seeded.
  let slackOk = 0;
  const okByKey = new Map<string, number>();
  setSlackClientForTest({
    async postMessage(args) {
      const key = args.text; // we set text = the idempotency key marker below
      if (key.includes("perm")) return { ok: false, class: "permanent", message: "forced_permanent" };
      const r = rand();
      if (r < 0.15) return { ok: false, class: "transient", message: "forced_500" };
      if (r < 0.20) return { ok: false, class: "rate_limited", retryAfterMs: 1, message: "forced_429" };
      slackOk++;
      okByKey.set(key, (okByKey.get(key) ?? 0) + 1);
      return { ok: true };
    },
    async updateMessage() { return { ok: true }; },
    async addReaction() { return { ok: true }; },
    async setSessionStatus() { return { ok: true }; },
    async startStream() { return { ok: true, ts: "stream.1" }; },
    async appendStream() { return { ok: true }; },
    async stopStream() { return { ok: true }; },
  });

  try {
    // Flood enqueue. ~8% of slack rows forced-permanent; ~8% of memory forced-fail.
    for (let i = 0; i < N_SLACK; i++) {
      const perm = i % 12 === 0 ? "perm" : "ok";
      const key = `soak-slack-${SEED}-${i}-${perm}`;
      await enqueuePostMessage({ idempotencyKey: key, channel: "C1", text: key, threadTs: "t.1" });
    }
    for (let i = 0; i < N_MEM; i++) {
      const hard = i % 12 === 0 ? "hardfail" : "ok";
      const runId = `soak-mem-${SEED}-${i}`;
      const prompt = `mem ${hard} ${runId}`;
      await enqueueCapture(runId, { teamId: "skynet", agentId: "skynet-backend", userId: "skynet", actorUserId: "skynet", sessionId: `thr-${i}`, runId } as any, { prompt, summary: `sum ${i}` });
    }
    rec.bump("enqueued_slack", N_SLACK);
    rec.bump("enqueued_mem", N_MEM);

    // Drain: deliver, fast-forward pending, repeat until terminal (cap iterations).
    // resolveSlackClient honors the setSlackClientForTest override.
    const { resolveSlackClient } = await import("../../../../src/slack/client");
    const slackClient = resolveSlackClient({ botToken: "x", signingSecret: "x", apiUrl: "http://localhost:1", defaultEngine: "mock" } as any);
    const pendingSlack = async () => Number((await db.execute(sql`select count(*)::int as n from slack_outbox where state in ('pending','delivering')`))[0]!.n);
    const pendingMem = async () => Number((await db.execute(sql`select count(*)::int as n from memory_outbox where state in ('pending','delivering')`))[0]!.n);
    for (let iter = 0; iter < 80; iter++) {
      await processDue(slackClient);
      await deliverDueCaptures(200);
      // fast-forward all pending rows so their backoff is immediately due.
      await db.execute(sql`update slack_outbox set next_attempt_at = now() where state = 'pending'`);
      await db.execute(sql`update memory_outbox set next_attempt_at = now() where state = 'pending'`);
      if ((await pendingSlack()) === 0 && (await pendingMem()) === 0) break;
      await sleep(3);
    }

    // ── assertions ────────────────────────────────────────────────────────────
    const sStuck = await pendingSlack();
    const mStuck = await pendingMem();
    rec.check(sStuck === 0, "slack: no stuck pending/delivering rows", `${sStuck} stuck`, { seed: SEED, sStuck });
    rec.check(mStuck === 0, "memory: no stuck pending/delivering rows", `${mStuck} stuck`, { seed: SEED, mStuck });

    const sCounts = (await db.execute(sql`select state, count(*)::int as n from slack_outbox group by state`)) as unknown as Array<{ state: string; n: number }>;
    const sMap = Object.fromEntries(sCounts.map((r) => [r.state, Number(r.n)]));
    const sDelivered = sMap.delivered ?? 0, sDead = sMap.dead ?? 0;
    rec.check(sDelivered + sDead === N_SLACK, "slack: no loss (delivered+dead==enqueued)", `${sDelivered}+${sDead} vs ${N_SLACK}`, { seed: SEED, sMap });
    rec.check(slackOk === sDelivered, "slack: exactly-once (client ok == delivered rows)", `ok=${slackOk} delivered=${sDelivered}`, { seed: SEED });
    const sDupKeys = [...okByKey.values()].filter((v) => v > 1).length;
    rec.check(sDupKeys === 0, "slack: zero duplicate deliveries", `${sDupKeys} keys delivered >1×`, { seed: SEED });
    // forced-permanent rows must be dead, never delivered.
    const permDelivered = Number((await db.execute(sql`select count(*)::int as n from slack_outbox where idempotency_key like '%-perm' and state='delivered'`))[0]!.n);
    rec.check(permDelivered === 0, "slack: forced-permanent never delivered", `${permDelivered} delivered`, { seed: SEED });
    const permDead = Number((await db.execute(sql`select count(*)::int as n from slack_outbox where idempotency_key like '%-perm' and state='dead'`))[0]!.n);
    rec.check(permDead > 0, "slack: forced-permanent dead-lettered", `${permDead} dead`, { seed: SEED });

    const mCounts = (await db.execute(sql`select state, count(*)::int as n from memory_outbox group by state`)) as unknown as Array<{ state: string; n: number }>;
    const mMap = Object.fromEntries(mCounts.map((r) => [r.state, Number(r.n)]));
    const mDelivered = mMap.delivered ?? 0, mDead = mMap.dead ?? 0;
    rec.check(mDelivered + mDead === N_MEM, "memory: no loss (delivered+dead==enqueued)", `${mDelivered}+${mDead} vs ${N_MEM}`, { seed: SEED, mMap });
    const mDup = [...memSuccessByPrompt.values()].filter((v) => v > 1).length;
    rec.check(mDup === 0, "memory: exactly-once (no prompt delivered >1×)", `${mDup} dup prompts`, { seed: SEED, receiverSuccesses: memSuccessByPrompt.size });
    const memHardDelivered = Number((await db.execute(sql`select count(*)::int as n from memory_outbox where payload like '%hardfail%' and state='delivered'`))[0]!.n);
    rec.check(memHardDelivered === 0, "memory: forced-fail never delivered", `${memHardDelivered} delivered`, { seed: SEED });
    const memHardDead = Number((await db.execute(sql`select count(*)::int as n from memory_outbox where payload like '%hardfail%' and state='dead'`))[0]!.n);
    rec.check(memHardDead > 0, "memory: forced-fail dead-lettered after maxAttempts", `${memHardDead} dead`, { seed: SEED });

    rec.bump("slack_delivered", sDelivered);
    rec.bump("slack_dead", sDead);
    rec.bump("mem_delivered", mDelivered);
    rec.bump("mem_dead", mDead);

    await client.end().catch(() => {});
  } catch (err) {
    rec.check(false, "harness error", err instanceof Error ? (err.stack ?? err.message) : String(err), { seed: SEED });
  } finally {
    memRecv.stop();
    await dropDb(DB);
  }
  rec.emit(Date.now() - t0, N_SLACK + N_MEM);
}

await main();
