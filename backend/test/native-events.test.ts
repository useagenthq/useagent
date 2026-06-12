import { describe, expect, test } from "bun:test";
import { fetchApi, json, readSse, waitFor } from "./helpers";
import { recordProviderEvent } from "../src/runs/provider-events";
import { createRun, setRunStatus } from "../src/runs/repo";

// Contract test for the versioned native-frame SSE lane (north star "Canonical
// Events"). All in-process against the app fetch handler; native events are
// seeded directly via recordProviderEvent, then observed on GET
// /api/runs/:id/events. The step/delta/done lane is unaffected (asserted).

/** Seed one native provider event (revisions reuse the same `pe_<partId>` id).
 *  The per-run sequencer mints the seq in call order, so callers seed in the
 *  order they want the seqs assigned. */
async function seed(
  runId: string,
  partId: string,
  payload: unknown,
  eventType = "part.tool.completed",
): Promise<void> {
  await recordProviderEvent({
    // Provider-event ids are globally unique in production. Include the run id
    // so this suite remains repeatable against the same durable test database.
    id: eventId(runId, partId),
    runId,
    threadId: runId,
    provider: "opencode",
    eventType,
    nativeSessionId: "ses_x",
    nativePartId: partId,
    payload,
  });
}

function eventId(runId: string, partId: string): string {
  return `pe_${runId}_${partId}`;
}

async function completedMockRun(prompt: string): Promise<string> {
  const created = await json<{ id: string }>("/api/runs", {
    method: "POST",
    body: { prompt },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  await waitFor(async () => {
    const { body } = await json<any>(`/api/runs/${id}`);
    return body?.status === "completed" ? body : null;
  });
  return id;
}

function nativeFrames(events: { event: string; data: string }[]) {
  return events.filter((e) => e.event === "native").map((e) => JSON.parse(e.data));
}

describe("native event SSE lane", () => {
  test("replays from cursor, ordered by seq, deduped by event id (latest revision)", async () => {
    const id = await completedMockRun("native replay");
    // Four distinct parts, then a REVISION of p1 (same id, higher seq) — the
    // store upserts by native id, so p1 collapses to its latest seq.
    await seed(id, "p0", { n: 0 });
    await seed(id, "p1", { n: 1 });
    await seed(id, "p2", { n: 2 });
    await seed(id, "p3", { n: 3 });
    await seed(id, "p1", { n: 1, revised: true });

    // Full replay (no cursor).
    const all = nativeFrames(
      await readSse(await fetchApi(`/api/runs/${id}/events`), {
        timeoutMs: 8000,
      }),
    );
    expect(all.map((f) => f.eventId)).toEqual([
      eventId(id, "p0"),
      eventId(id, "p2"),
      eventId(id, "p3"),
      eventId(id, "p1"),
    ]);
    // Ordered strictly ascending by seq.
    expect(all.map((f) => f.seq)).toEqual([0, 2, 3, 4]);
    // Deduped by event id — pe_p1 appears once, at its latest revision.
    expect(all.filter((f) => f.eventId === eventId(id, "p1"))).toHaveLength(1);
    expect(all.find((f) => f.eventId === eventId(id, "p1")).payload).toEqual({
      n: 1,
      revised: true,
    });
    // Every frame carries the versioned envelope + native ids.
    expect(all[0].schemaVersion).toBe(1);
    expect(all[0].provider).toBe("opencode");
    expect(all[0].native.partId).toBe("p0");

    // Cursor replay: only seq > 2.
    const fromCursor = nativeFrames(
      await readSse(await fetchApi(`/api/runs/${id}/events?cursor=2`), { timeoutMs: 8000 }),
    );
    expect(fromCursor.map((f) => f.seq)).toEqual([3, 4]);
    expect(fromCursor.map((f) => f.eventId)).toEqual([
      eventId(id, "p3"),
      eventId(id, "p1"),
    ]);
  });

  test("the step/delta/done lane is unchanged alongside native frames", async () => {
    const id = await completedMockRun("native + steps");
    await seed(id, "px", { ok: true });
    const events = await readSse(await fetchApi(`/api/runs/${id}/events`), {
      timeoutMs: 8000,
    });
    // Steps still replay (8 scripted) and done still terminates the stream.
    expect(events.filter((e) => e.event === "step")).toHaveLength(8);
    expect(events.find((e) => e.event === "done")).toBeDefined();
    expect(nativeFrames(events)).toHaveLength(1);
  });

  test("payloads are bounded: oversized → marker, small → parsed object", async () => {
    const id = await completedMockRun("native bounded");
    await seed(id, "small", { hello: "world" });
    // > 32KiB ordinary payloads are replaced by a valid bounded marker.
    await seed(id, "big", { blob: "x".repeat(40_000) });

    const frames = nativeFrames(
      await readSse(await fetchApi(`/api/runs/${id}/events`), {
        timeoutMs: 8000,
      }),
    );
    const small = frames.find((f) => f.eventId === eventId(id, "small"));
    const big = frames.find((f) => f.eventId === eventId(id, "big"));

    expect(small.payload).toEqual({ hello: "world" });
    expect(big.payload).toMatchObject({
      _truncated: true,
      _reason: "provider payload exceeded durable byte limit",
    });
    expect(big.payload._original_bytes).toBeGreaterThan(32_768);
    // The whole frame stays bounded regardless of the source payload size.
    expect(JSON.stringify(big).length).toBeLessThan(33_000);
  });

  test("preserves an unknown provider event and its native correlation fields", async () => {
    const id = await completedMockRun("unknown native event");
    await recordProviderEvent({
      id: eventId(id, "pi-experimental"),
      runId: id,
      threadId: id,
      provider: "pi",
      eventType: "pi.experimental.capability",
      nativeSessionId: "pi-session",
      nativeParentSessionId: "pi-parent",
      nativeMessageId: "pi-message",
      nativePartId: "pi-part",
      nativeCallId: "pi-call",
      payload: { capability: "future-tool", detail: { version: 2 } },
    });

    const frames = nativeFrames(
      await readSse(await fetchApi(`/api/runs/${id}/events`), {
        timeoutMs: 8000,
      }),
    );
    expect(frames.find((frame) => frame.eventId === eventId(id, "pi-experimental"))).toEqual({
      schemaVersion: 1,
      eventId: eventId(id, "pi-experimental"),
      seq: 0,
      provider: "pi",
      eventType: "pi.experimental.capability",
      native: {
        sessionId: "pi-session",
        parentSessionId: "pi-parent",
        messageId: "pi-message",
        partId: "pi-part",
        callId: "pi-call",
      },
      payload: { capability: "future-tool", detail: { version: 2 } },
    });
  });

  test("live-pushes a native frame persisted after the client connects", async () => {
    // A running run keeps the SSE open (no `done`), so a post-connect emit must
    // arrive via the live lane, not replay (the native lane is empty at connect).
    const id = crypto.randomUUID();
    await createRun({
      id,
      prompt: "live native",
      model: "claude-opus-5",
      engine: "mock",
      orgId: "org-skynet-dev",
      userId: null,
      parentRunId: null,
      threadId: id,
    });
    await setRunStatus(id, "running");

    const res = await fetchApi(`/api/runs/${id}/events`);
    const reading = readSse(res, { timeoutMs: 1500 }); // no done → reads until timeout
    await new Promise((r) => setTimeout(r, 200)); // let subscribe + empty replay settle
    await seed(id, "live1", { live: true });

    const frames = nativeFrames(await reading);
    const live = frames.find((f) => f.eventId === eventId(id, "live1"));
    expect(live).toBeDefined();
    expect(live.payload).toEqual({ live: true });
    expect(live.seq).toBe(0);
  });
});
