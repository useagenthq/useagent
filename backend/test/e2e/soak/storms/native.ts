/**
 * STORM (e) — native-lane storms. High-frequency native capture (concurrent
 * batches + revisions + a cross-emitter ledger frame) followed by RANDOMIZED
 * SSE kill + reconnect-from-cursor replays. Asserts the per-run sequencer's
 * invariant end-to-end: a client that reconnects at `?cursor=<highest seq seen>`
 * reassembles EVERY provider_events row — zero missing, zero extra, strictly-
 * later replay only, unique+monotonic seq.
 *
 * In-process (binds the real SSE route from src/index on a port). Each run gets a
 * random number of frames, a random first-kill point, and 1–4 further random
 * reconnect/kill cycles — so the cursor low-water-mark is exercised from many
 * offsets. A subset publishes half its frames LIVE (after the first connect) to
 * stress the replay+live overlap dedupe.
 */
import { recreateDb, dropDb, sleep } from "../lib/inproc";
import { Recorder, rng } from "../lib/report";

const SEED = Number(process.env.SOAK_SEED ?? Date.now() % 2_000_000_000);
const RUNS = Number(process.env.SOAK_NATIVE_RUNS ?? 24);
const PORT = Number(process.env.SOAK_PORT ?? 3516) + 60;
const DB = `skynet_soak_native_${PORT}`;

const rec = new Recorder("native");
const rand = rng(SEED);

process.env.DATABASE_URL = `postgres://postgres@localhost:5432/${DB}`;
process.env.PORT = String(PORT);
delete process.env.MEMORY_API_URL;
delete process.env.SLACK_BOT_TOKEN;
delete process.env.OPENROUTER_API_KEY;

interface Frame { eventId: string; seq: number }

/** Read native SSE frames until the signal aborts / stream ends. */
async function readNative(url: string, onFrame: (f: Frame) => void, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch {
    return;
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let ev = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (ev === "native" && data) {
          const o = JSON.parse(data);
          onFrame({ eventId: o.eventId, seq: o.seq });
          if (signal.aborted) return;
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function main(): Promise<void> {
  const t0 = Date.now();
  await recreateDb(DB);

  const { default: server } = await import("../../../../src/index");
  const bun = Bun.serve({ port: PORT, fetch: server.fetch, idleTimeout: 60 });
  const base = `http://localhost:${PORT}`;

  const { createRun, setRunStatus } = await import("../../../../src/runs/repo");
  const { recordProviderEvent } = await import("../../../../src/runs/provider-events");
  const { db } = await import("../../../../src/db/client");
  const { providerEvents } = await import("../../../../src/db/schema");
  const { asc, eq } = await import("drizzle-orm");

  try {
    for (let run = 0; run < RUNS; run++) {
      const id = crypto.randomUUID();
      await createRun({ id, prompt: "native soak", model: "m", engine: "mock", orgId: "org-skynet-dev", userId: null, parentRunId: null, threadId: id });
      await setRunStatus(id, "running");
      const live = rand() < 0.4; // half publish some frames after the first connect
      const nBatches = 4 + Math.floor(rand() * 6); // 4..9 batches of 5 = 20..45 frames
      const revisions = 2 + Math.floor(rand() * 4);
      const ev = { seed: SEED, run, nBatches, revisions, live };

      // Cross-emitter ledger frame first (the seq-0 collision the sequencer fixed).
      await recordProviderEvent({ id: `ctxret_${id}`, runId: id, threadId: id, provider: "skynet", eventType: "context.retrieved", payload: { items: 2 } });

      const seedBatch = async (from: number, count: number) => {
        for (let b = 0; b < count; b++) {
          await Promise.all(Array.from({ length: 5 }, (_, k) => {
            const nn = from + b * 5 + k;
            return recordProviderEvent({ id: `${id}::p${nn}`, runId: id, threadId: id, provider: "opencode", eventType: "part.tool.completed", nativePartId: `p${nn}`, payload: { nn } });
          }));
        }
      };
      const preBatches = live ? Math.ceil(nBatches / 2) : nBatches;
      await seedBatch(0, preBatches);

      const store = new Map<string, number>();
      let cursor = -1;
      let outOfOrder = 0;
      const onFrame = (f: Frame, resumed: boolean) => {
        if (resumed && f.seq <= cursor) outOfOrder++;
        store.set(f.eventId, Math.max(store.get(f.eventId) ?? -1, f.seq));
        if (f.seq > cursor) cursor = f.seq;
      };

      // First connection — kill after a RANDOM number of frames.
      const killAfter = 3 + Math.floor(rand() * 8);
      let got = 0;
      const ac1 = new AbortController();
      await readNative(`${base}/api/runs/${id}/events?cursor=-1`, (f) => {
        onFrame(f, false);
        if (++got >= killAfter) ac1.abort();
      }, ac1.signal);

      // If live, publish the remaining batches + revisions now (between connects).
      if (live) await seedBatch(preBatches * 5, nBatches - preBatches);
      await Promise.all(Array.from({ length: revisions }, (_, r) => {
        const nn = Math.floor(rand() * (nBatches * 5));
        return recordProviderEvent({ id: `${id}::p${nn}`, runId: id, threadId: id, provider: "opencode", eventType: "part.tool.completed", nativePartId: `p${nn}`, payload: { nn, revised: r } });
      }));

      // 1..4 random reconnect/kill cycles, then a final full drain.
      const reconnects = 1 + Math.floor(rand() * 4);
      for (let rc = 0; rc < reconnects; rc++) {
        const ac = new AbortController();
        const killN = 2 + Math.floor(rand() * 6);
        let n = 0;
        const timer = setTimeout(() => ac.abort(), 500);
        await readNative(`${base}/api/runs/${id}/events?cursor=${cursor}`, (f) => {
          onFrame(f, true);
          if (++n >= killN) ac.abort();
        }, ac.signal);
        clearTimeout(timer);
        await sleep(2);
      }
      // Final drain to completion.
      const acF = new AbortController();
      const timerF = setTimeout(() => acF.abort(), 700);
      await readNative(`${base}/api/runs/${id}/events?cursor=${cursor}`, (f) => onFrame(f, true), acF.signal);
      clearTimeout(timerF);

      // Truth: every provider_events row for the run.
      const rows = await db.select({ id: providerEvents.id, seq: providerEvents.seq }).from(providerEvents).where(eq(providerEvents.runId, id)).orderBy(asc(providerEvents.seq));
      const expected = new Map(rows.map((r) => [r.id, r.seq]));
      const seqs = rows.map((r) => r.seq);
      const uniqueSeq = new Set(seqs).size === seqs.length;
      const monotonic = seqs.every((s, i) => i === 0 || s > seqs[i - 1]!);
      const missing = [...expected].filter(([eid, seq]) => store.get(eid) !== seq);
      const extra = [...store].filter(([eid]) => !expected.has(eid));

      rec.check(uniqueSeq, "seq unique across all emitters", `${seqs.length} rows`, ev);
      rec.check(monotonic, "seq strictly monotonic in the snapshot", "", ev);
      rec.check(outOfOrder === 0, "reconnect replayed only strictly-later frames", `${outOfOrder} ≤cursor`, ev);
      rec.check(missing.length === 0, "ZERO missing seq after random reconnects", `${missing.length} missing of ${expected.size}`, { ...ev, missing: missing.slice(0, 8), storeSize: store.size, expected: expected.size });
      rec.check(extra.length === 0, "no extra frames vs provider_events", `${extra.length} extra`, ev);
      rec.bump("runs");
      rec.bump("frames", rows.length);
    }
  } catch (err) {
    rec.check(false, "harness error", err instanceof Error ? (err.stack ?? err.message) : String(err), { seed: SEED });
  } finally {
    bun.stop(true);
    const { client } = await import("../../../../src/db/client");
    await client.end().catch(() => {});
    await dropDb(DB);
  }
  rec.emit(Date.now() - t0, rec.stats.runs ?? 0);
}

await main();
