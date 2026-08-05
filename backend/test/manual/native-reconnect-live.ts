/**
 * GAP-1 live proof — kill the native SSE mid-fanout at the NETWORK level (abort
 * the socket, backend stays up), reconnect from the cursor, assert ZERO missing
 * seq in the reassembled client store vs the provider_events rows.
 *
 * NOT in `bun test` — it binds a real port and drops a throwaway DB. Run:
 *   bun test/manual/native-reconnect-live.ts
 *
 * No Daytona: the native frames are produced through the REAL capture path
 * (recordProviderEvent — the same per-run sequencer opencode uses), seeded with
 * concurrency + revisions to mimic a subagent fanout. The transport under test —
 * the sequencer's ordered/unique seq, the SSE replay-from-cursor, and the client
 * merge — is identical regardless of what emits the frames.
 */
import postgres from "postgres";

const DB = "skynet_nativekill";
const PORT = 3507;
const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";

async function recreateDb(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
  } finally {
    await admin.end();
  }
}

// Env MUST be set before importing the app (db client + migrator + port read at import).
await recreateDb();
process.env.DATABASE_URL = `postgres://postgres@localhost:5432/${DB}`;
process.env.PORT = String(PORT);
delete process.env.MEMORY_API_URL; // no external memory calls
delete process.env.SLACK_BOT_TOKEN; // no slack mount
delete process.env.OPENROUTER_API_KEY;

const { default: server } = await import("../../src/index");
const bun = Bun.serve({ port: PORT, fetch: server.fetch, idleTimeout: 60 });

const { createRun, setRunStatus } = await import("../../src/runs/repo");
const { recordProviderEvent } = await import("../../src/runs/provider-events");
const { db, client } = await import("../../src/db/client");
const { providerEvents } = await import("../../src/db/schema");
const { asc, eq } = await import("drizzle-orm");

const base = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Frame { eventId: string; seq: number }

/** Read native SSE frames; invoke onFrame for each. Aborts cleanly on signal. */
async function readNative(url: string, onFrame: (f: Frame) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let curEvent = "message";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        curEvent = "message";
        let data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) curEvent = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (curEvent === "native" && data) {
          const o = JSON.parse(data);
          onFrame({ eventId: o.eventId, seq: o.seq });
          // Stop draining the instant the caller kills the socket — the frames
          // still buffered here are LOST to the client (that IS the network kill).
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
  // 1) A live run + a "fanout" of native captures (concurrent batches + revisions).
  const id = crypto.randomUUID();
  await createRun({ id, prompt: "native reconnect fanout", model: "claude-opus-5", engine: "mock", orgId: "org-skynet-dev", userId: null, parentRunId: null, threadId: id });
  await setRunStatus(id, "running");

  // Retrieval-ledger-style frame first (the cross-emitter that used to collide on seq 0).
  await recordProviderEvent({ id: `ctxret_${id}`, runId: id, threadId: id, provider: "skynet", eventType: "context.retrieved", payload: { items: 2 } });
  // 30 part captures in 6 concurrent batches of 5 (out-of-order insert resolution),
  // then revise 4 of them (each mints a fresh higher seq).
  for (let b = 0; b < 6; b++) {
    await Promise.all(Array.from({ length: 5 }, (_, k) => {
      const n = b * 5 + k;
      return recordProviderEvent({ id: `${id}::p${n}`, runId: id, threadId: id, provider: "opencode", eventType: "part.tool.completed", nativePartId: `p${n}`, payload: { n } });
    }));
  }
  await Promise.all([0, 7, 15, 22].map((n) =>
    recordProviderEvent({ id: `${id}::p${n}`, runId: id, threadId: id, provider: "opencode", eventType: "part.tool.completed", nativePartId: `p${n}`, payload: { n, revised: true } }),
  ));

  const rows = await db.select({ id: providerEvents.id, seq: providerEvents.seq }).from(providerEvents).where(eq(providerEvents.runId, id)).orderBy(asc(providerEvents.seq));
  const expected = new Map(rows.map((r) => [r.id, r.seq]));
  const totalSeqs = rows.map((r) => r.seq);
  const uniqueSeq = new Set(totalSeqs).size === totalSeqs.length;
  console.log(`seeded: ${rows.length} rows, seq range [${totalSeqs[0]}..${totalSeqs.at(-1)}], unique=${uniqueSeq}`);

  // 2) FIRST connection — read only the first few frames, then kill the socket
  //    (network-level abort) with the rest still unread/in-flight.
  const store = new Map<string, number>();
  let cursor = -1;
  const KILL_AFTER = 6;
  let got = 0;
  const ac1 = new AbortController();
  await readNative(`${base}/api/runs/${id}/events?cursor=-1`, (f) => {
    store.set(f.eventId, Math.max(store.get(f.eventId) ?? -1, f.seq));
    if (f.seq > cursor) cursor = f.seq;
    if (++got >= KILL_AFTER) ac1.abort(); // NETWORK KILL mid-stream
  }, ac1.signal);
  console.log(`first connection: read ${got} frames, killed at cursor=${cursor} (store has ${store.size})`);

  await sleep(150); // simulate the reconnect delay; more frames could be published meanwhile

  // 3) RECONNECT from the cursor — server replays strictly-later frames only.
  const ac2 = new AbortController();
  const timer = setTimeout(() => ac2.abort(), 2500);
  let resumed = 0;
  let outOfOrder = 0;
  let lastSeq = cursor;
  await readNative(`${base}/api/runs/${id}/events?cursor=${cursor}`, (f) => {
    if (f.seq <= cursor) outOfOrder++; // must NOT happen: strictly-later only
    if (f.seq < lastSeq) outOfOrder++;
    lastSeq = f.seq;
    store.set(f.eventId, Math.max(store.get(f.eventId) ?? -1, f.seq));
    resumed++;
  }, ac2.signal);
  clearTimeout(timer);
  console.log(`reconnect: replayed ${resumed} later frames; out-of-order/re-sent-≤cursor: ${outOfOrder}`);

  // 4) ASSERT: the reassembled client store == every provider_events row (zero missing).
  const missing = [...expected].filter(([eid, seq]) => store.get(eid) !== seq);
  const extra = [...store].filter(([eid]) => !expected.has(eid));
  console.log(`\nRESULT: store=${store.size} expected=${expected.size} missing=${missing.length} extra=${extra.length}`);
  if (missing.length) console.log("MISSING:", missing.slice(0, 10));
  const pass = uniqueSeq && missing.length === 0 && extra.length === 0 && outOfOrder === 0;
  console.log(pass ? "\n✅ PASS — zero missing seq after a network-level SSE kill + reconnect" : "\n❌ FAIL");

  bun.stop(true);
  await client.end().catch(() => {});
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB} AND pid <> pg_backend_pid()`.catch(() => {});
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`).catch(() => {});
  await admin.end();
  process.exit(pass ? 0 : 1);
}

await main();
