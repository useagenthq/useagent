import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { fetchApi, readSse } from "./helpers";
import { db } from "../src/db/client";
import { providerEvents } from "../src/db/schema";
import { recordProviderEvent } from "../src/runs/provider-events";
import { createRun, setRunStatus } from "../src/runs/repo";

// Regression for GAP 1: reconnect can lose native events. The reconnect cursor
// (`?cursor=<highest seq seen>`, replayed as `seq > cursor`) is lossless ONLY if
// every run's native lane assigns a UNIQUE, MONOTONIC seq and publishes in that
// order. Two ways it used to break — two emitters both minting seq 0 (a cursor of
// 0 skipped the sibling row), and fire-and-forget captures publishing out of
// order (a lower seq delivered late, skipped forever on reconnect). These tests
// pin the restored invariant + prove reconnect-from-cursor loses nothing.
//
// Native-event ids are the table PRIMARY KEY and are session-unique in production
// (`pe_<opencodePartId>`, `ctxret_<runId>`). Tests namespace ids per run the same
// way so seeded rows never collide across tests sharing the one test database.

async function runningRun(prompt: string): Promise<string> {
  const id = crypto.randomUUID();
  await createRun({
    id, prompt, model: "claude-opus-5", engine: "mock",
    orgId: "org-skynet-dev", userId: null, parentRunId: null, threadId: id,
  });
  await setRunStatus(id, "running"); // stays live so SSE replays + closes cleanly
  return id;
}

/** A run-namespaced native-event id (globally unique, like production part ids). */
const evId = (runId: string, name: string): string => `${runId}::${name}`;

async function rowsFor(runId: string) {
  return db
    .select({ id: providerEvents.id, seq: providerEvents.seq })
    .from(providerEvents)
    .where(eq(providerEvents.runId, runId))
    .orderBy(asc(providerEvents.seq));
}

function nativeFrames(events: { event: string; data: string }[]) {
  return events.filter((e) => e.event === "native").map((e) => JSON.parse(e.data));
}

describe("native lane — unique/monotonic seq (reconnect losslessness)", () => {
  test("cross-emitter captures never collide on a seq (retrieval-ledger + opencode)", async () => {
    const id = await runningRun("cross-emitter seq");
    // The retrieval ledger emits at run START (provider "skynet"); opencode parts
    // emit during the run. Both flow through recordProviderEvent, so the shared
    // per-run counter gives the ledger seq 0 and every part a strictly higher one.
    await recordProviderEvent({
      id: `ctxret_${id}`, runId: id, threadId: id, provider: "skynet",
      eventType: "context.retrieved", payload: { items: 3 },
    });
    await recordProviderEvent({
      id: evId(id, "p0"), runId: id, threadId: id, provider: "opencode",
      eventType: "part.tool.completed", nativePartId: "p0", payload: { n: 0 },
    });

    const rows = await rowsFor(id);
    expect(rows.map((r) => r.id)).toEqual([`ctxret_${id}`, evId(id, "p0")]);
    expect(rows.map((r) => r.seq)).toEqual([0, 1]); // NOT [0, 0] — no collision
  });

  test("concurrent fire-and-forget captures get unique, contiguous seqs", async () => {
    const id = await runningRun("concurrent seq");
    // Fire 40 captures WITHOUT awaiting each (the production hot path). Without the
    // per-run serial chain their inserts+publishes would resolve out of order and
    // could duplicate a seq; the chain assigns 0..39 in call order.
    const N = 40;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        recordProviderEvent({
          id: evId(id, `c${i}`), runId: id, threadId: id, provider: "opencode",
          eventType: "part.tool.completed", nativePartId: `c${i}`, payload: { i },
        }),
      ),
    );

    const seqs = (await rowsFor(id)).map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i)); // 0..39, unique, contiguous
    expect(new Set(seqs).size).toBe(N); // no duplicate seq under concurrency
  });

  test("a revision mints a higher seq; the vacated seq is not reused", async () => {
    const id = await runningRun("revision seq");
    await recordProviderEvent({ id: evId(id, "a"), runId: id, threadId: id, provider: "opencode", eventType: "part.tool.running", nativePartId: "a", payload: { s: "run" } });
    await recordProviderEvent({ id: evId(id, "b"), runId: id, threadId: id, provider: "opencode", eventType: "part.tool.completed", nativePartId: "b", payload: { s: "ok" } });
    // Revise "a" (same id) — it must jump ABOVE b, never reuse its old seq 0.
    await recordProviderEvent({ id: evId(id, "a"), runId: id, threadId: id, provider: "opencode", eventType: "part.tool.completed", nativePartId: "a", payload: { s: "ok" } });

    const rows = await rowsFor(id);
    const byId = new Map(rows.map((r) => [r.id, r.seq]));
    expect(byId.get(evId(id, "b"))).toBe(1);
    expect(byId.get(evId(id, "a"))).toBe(2); // revised above b; seq 0 is vacated, not reused
    expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length); // still unique
  });

  test("reconnect from cursor replays every later frame — client store loses nothing", async () => {
    const id = await runningRun("reconnect losslessness");
    // Seed a realistic burst incl. a revision, all through the sequencer.
    for (const p of ["p0", "p1", "p2", "p3", "p4"]) {
      await recordProviderEvent({ id: evId(id, p), runId: id, threadId: id, provider: "opencode", eventType: "part.tool.completed", nativePartId: p, payload: { p } });
    }
    await recordProviderEvent({ id: evId(id, "p1"), runId: id, threadId: id, provider: "opencode", eventType: "part.tool.completed", nativePartId: "p1", payload: { p: "p1", revised: true } });

    // The full set the client MUST end up with: one entry per id at its latest seq.
    const expected = new Map((await rowsFor(id)).map((r) => [r.id, r.seq]));

    // FIRST connection: read the whole replay, then take a mid cursor as if the
    // socket dropped there (client keeps everything ≤ cursor).
    const first = nativeFrames(await readSse(await fetchApi(`/api/runs/${id}/events?cursor=-1`), { timeoutMs: 2000 }));
    const midCursor = first[2]!.seq; // pretend the drop happened after the 3rd frame
    const store = new Map<string, number>();
    for (const f of first) {
      if (f.seq <= midCursor && (store.get(f.eventId) ?? -1) < f.seq) store.set(f.eventId, f.seq);
    }

    // RECONNECT with the cursor: the server replays strictly-later frames; the
    // client merges them (dedupe by eventId, keep the highest seq).
    const resumed = nativeFrames(await readSse(await fetchApi(`/api/runs/${id}/events?cursor=${midCursor}`), { timeoutMs: 2000 }));
    for (const f of resumed) {
      if ((store.get(f.eventId) ?? -1) < f.seq) store.set(f.eventId, f.seq);
    }

    // ZERO missing seq: the reassembled store equals the provider_events rows.
    expect(store.size).toBe(expected.size);
    for (const [eventId, seq] of expected) expect(store.get(eventId)).toBe(seq);
    // And the resume only re-sent strictly-later frames (no full re-replay).
    expect(resumed.every((f) => f.seq > midCursor)).toBe(true);
  });
});
