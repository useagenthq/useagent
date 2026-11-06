import { afterEach, describe, expect, test } from "bun:test";
import server from "../src/index";
import { BASE, ORIGIN, createOrgSession, waitFor } from "./helpers";
import { createRun, insertStep, setRunStatus, type ApiStep } from "../src/runs/repo";
import { recordProviderEvent } from "../src/runs/provider-events";
import { makeNativeFrame, publishNativeFrame } from "../src/runs/native-events";
import { bus, channel } from "../src/worker";
import { turnStream } from "../src/runs/turn-stream";
import { publishThreadChange } from "../src/runs/thread-signals";
import { acceptRunCommand } from "../src/commands";
import { persistAndPublish } from "../src/runs/canonical-events";
import { STREAM_EPOCH } from "../src/runs/thread-resume";
import { nativeHoldDigest } from "@useagent/agent-client";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { canonicalizationOutbox, providerEvents } from "../src/db/schema";
import { translateOpenCode, type OpenCodeFrame } from "../src/engines/opencode-canonical";
import { PLATFORM_EVENT_LANES } from "@useagent/agent-harness/canonical";

// Deterministic tests for the ADDITIVE thread SSE stream
// (GET /api/runs/:rootRunId/thread-events, final_fix.md §4.2/§5.2). These drive
// the durable sources + live buses DIRECTLY (like native-reconnect.test.ts), so
// state transitions are observable without racing the real worker: a thread is
// seeded with createRun/insertStep/recordProviderEvent, and live frames are
// injected via bus.emit / turnStream / publishNativeFrame / acceptRunCommand.

// ── An in-process SSE client that stays open (the thread stream never sends a
//    top-level `done`, so the shared readSse — which stops at the first `done`
//    event — can't drive these). Reads frames continuously and lets a test await
//    a predicate over what has arrived, then disconnect via AbortController.
interface Frame {
  event: string;
  data: any;
}
interface StreamClient {
  res: Response;
  frames: Frame[];
  waitFrame(pred: (frames: Frame[]) => boolean, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

function parseFrame(raw: string): Frame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat / open comment
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  let data: unknown = dataLines.join("\n");
  try {
    data = JSON.parse(data as string);
  } catch {
    /* leave as string */
  }
  return { event, data };
}

async function openStream(path: string, cookies: string): Promise<StreamClient> {
  const ac = new AbortController();
  const res = await server.fetch(
    new Request(BASE + path, {
      headers: { origin: ORIGIN, cookie: cookies },
      signal: ac.signal,
    }),
  );
  const frames: Frame[] = [];
  const waiters: { pred: (f: Frame[]) => boolean; resolve: () => void }[] = [];
  const check = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(frames)) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const pump = (async () => {
    if (!res.body) return;
    reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const f = parseFrame(chunk);
          if (f) {
            frames.push(f);
            check();
          }
        }
      }
    } catch {
      /* aborted on close() */
    }
  })();
  const waitFrame = (pred: (f: Frame[]) => boolean, timeoutMs = 3000): Promise<void> =>
    new Promise((resolve, reject) => {
      if (pred(frames)) return resolve();
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) {
          waiters.splice(i, 1);
          reject(new Error("waitFrame timeout"));
        }
      }, timeoutMs);
    });
  const close = async (): Promise<void> => {
    ac.abort();
    try {
      await reader?.cancel();
    } catch {
      /* ignore */
    }
    await pump.catch(() => {});
  };
  return { res, frames, waitFrame, close };
}

const clients: StreamClient[] = [];
async function open(path: string, cookies: string): Promise<StreamClient> {
  const c = await openStream(path, cookies);
  clients.push(c);
  return c;
}
afterEach(async () => {
  while (clients.length) await clients.pop()!.close();
});

/** Create a run in an org with a controlled created_at ordering (a tiny gap so
 *  getThreadForRun's created_at ordering is deterministic across sibling runs). */
async function seedRun(opts: {
  orgId: string;
  id?: string;
  threadId?: string;
  parentRunId?: string | null;
  status?: "queued" | "running" | "completed" | "failed";
}): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  await createRun({
    id,
    prompt: `prompt ${id.slice(0, 6)}`,
    model: "claude-opus-5",
    engine: "mock",
    orgId: opts.orgId,
    userId: null,
    parentRunId: opts.parentRunId ?? null,
    threadId: opts.threadId ?? id,
    repos: [],
    memoryScope: "org",
  });
  if (opts.status && opts.status !== "queued") await setRunStatus(id, opts.status);
  await new Promise((r) => setTimeout(r, 6)); // ensure strictly increasing created_at
  return id;
}

const snapshotOf = (frames: Frame[]): Frame | undefined =>
  frames.find((f) => f.event === "snapshot");
const runIds = (snap: Frame): string[] => snap.data.runs.map((r: any) => r.id);

describe("thread-events — auth + snapshot", () => {
  test("missing root run → 404 (no stream opened)", async () => {
    const org = await createOrgSession("te-404");
    const c = await open(`/api/runs/${crypto.randomUUID()}/thread-events`, org.cookies);
    expect(c.res.status).toBe(404);
  });

  test("cross-org root run → 404 (fails closed, indistinguishable from missing)", async () => {
    const a = await createOrgSession("te-a");
    const b = await createOrgSession("te-b");
    const root = await seedRun({ orgId: a.orgId });
    const c = await open(`/api/runs/${root}/thread-events`, b.cookies);
    expect(c.res.status).toBe(404);
  });

  test("SSE headers + open prime present", async () => {
    const org = await createOrgSession("te-hdr");
    const root = await seedRun({ orgId: org.orgId });
    const c = await open(`/api/runs/${root}/thread-events`, org.cookies);
    expect(c.res.status).toBe(200);
    expect(c.res.headers.get("content-type")).toContain("text/event-stream");
    expect(c.res.headers.get("cache-control")).toContain("no-transform");
    expect(c.res.headers.get("x-accel-buffering")).toBe("no");
    await c.waitFrame((f) => f.some((x) => x.event === "snapshot"));
  });

  test("snapshot is the authorized thread only, oldest→newest, with steps", async () => {
    const org = await createOrgSession("te-snap");
    const root = await seedRun({ orgId: org.orgId });
    const reply = await seedRun({ orgId: org.orgId, threadId: root, parentRunId: root });
    // A sibling thread in the SAME org must NOT leak into this thread's snapshot.
    const other = await seedRun({ orgId: org.orgId });
    await insertStep({ runId: root, idx: 0, kind: "task", label: "boot", chip: "opencode", code: null });

    const c = await open(`/api/runs/${root}/thread-events`, org.cookies);
    await c.waitFrame((f) => f.some((x) => x.event === "snapshot"));
    const snap = snapshotOf(c.frames)!;
    expect(runIds(snap)).toEqual([root, reply]); // oldest→newest, other thread excluded
    expect(runIds(snap)).not.toContain(other);
    expect(snap.data.threadId).toBe(root);
    const rootRun = snap.data.runs.find((r: any) => r.id === root);
    expect(rootRun.steps.some((s: ApiStep) => s.label === "boot")).toBe(true);
  });

  test("replays each run's durable native frames, tagged with the right runId", async () => {
    const org = await createOrgSession("te-native");
    const root = await seedRun({ orgId: org.orgId, status: "running" });
    const reply = await seedRun({ orgId: org.orgId, threadId: root, parentRunId: root, status: "running" });
    await recordProviderEvent({ id: `${root}::p0`, runId: root, threadId: root, provider: "opencode", eventType: "part.tool.completed", nativePartId: "p0", payload: { a: 1 } });
    await recordProviderEvent({ id: `${reply}::p0`, runId: reply, threadId: root, provider: "opencode", eventType: "part.tool.completed", nativePartId: "p0", payload: { b: 2 } });

    const c = await open(`/api/runs/${root}/thread-events`, org.cookies);
    await c.waitFrame(
      (f) =>
        f.some((x) => x.event === "native" && x.data.runId === root) &&
        f.some((x) => x.event === "native" && x.data.runId === reply),
    );
    const natives = c.frames.filter((x) => x.event === "native");
    // Every native frame carries its owning runId and a well-formed frame.
    for (const n of natives) {
      expect(typeof n.data.runId).toBe("string");
      expect(typeof n.data.frame.eventId).toBe("string");
      expect(n.data.threadId).toBe(root);
    }
    expect(natives.find((n) => n.data.frame.eventId === `${root}::p0`)!.data.runId).toBe(root);
    expect(natives.find((n) => n.data.frame.eventId === `${reply}::p0`)!.data.runId).toBe(reply);
  });
});

describe("thread-events — live multiplexing", () => {
  test("an externally accepted run appears as a `run` frame WITHOUT reconnect, then streams", async () => {
    const org = await createOrgSession("te-ext");
    const root = await seedRun({ orgId: org.orgId, status: "running" });
    const c = await open(`/api/runs/${root}/thread-events`, org.cookies);
    await c.waitFrame((f) => f.some((x) => x.event === "snapshot"));

    // Simulate Slack/schedule central acceptance adding a run to THIS thread.
    const replyId = crypto.randomUUID();
    const accepted = await acceptRunCommand({
      idempotencyKey: null,
      orgId: org.orgId,
      actorId: null,
      run: {
        id: replyId, prompt: "external turn", model: "claude-opus-5", engine: "mock",
        parentRunId: root, threadId: root, repos: [], memoryScope: "org",
        skillId: null, skillVersion: null, skillContentHash: null,
      },
    });
    expect(accepted.status).toBe("created");

    // The run frame arrives on the SAME connection (no reconnect / no snapshot #2).
    await c.waitFrame((f) => f.some((x) => x.event === "run" && x.data.run.id === replyId));
    expect(c.frames.filter((x) => x.event === "snapshot").length).toBe(1);

    // ...and the newly-attached run then streams its live frames (proves attach).
    publishNativeFrame(root === replyId ? root : replyId, makeNativeFrame({
      eventId: `${replyId}::live0`, seq: 0, provider: "opencode", eventType: "part.tool.running",
      sessionId: null, parentSessionId: null, messageId: null, partId: "live0", callId: null, payloadText: null,
    }));
    await c.waitFrame((f) => f.some((x) => x.event === "native" && x.data.runId === replyId && x.data.frame.eventId === `${replyId}::live0`));
  });

  test("a delta and a step both stream tagged with the correct runId", async () => {
    const org = await createOrgSession("te-live");
    const root = await seedRun({ orgId: org.orgId, status: "running" });
    const c = await open(`/api/runs/${root}/thread-events`, org.cookies);
    await c.waitFrame((f) => f.some((x) => x.event === "snapshot"));

    const { turnStream } = await import("../src/runs/turn-stream");
    turnStream.publish(root, "hello ");
    await c.waitFrame((f) => f.some((x) => x.event === "delta" && x.data.runId === root && x.data.delta === "hello "));

    const step = await insertStep({ runId: root, idx: 10, kind: "command", label: "ls", chip: null, code: { tool: "bash" } });
    bus.emit(channel(root), { type: "step", step });
    await c.waitFrame((f) => f.some((x) => x.event === "step" && x.data.runId === root && x.data.step.idx === 10));
  });

  test("replay/live overlap does not duplicate a step (identical suppressed, enriched passes)", async () => {
    const org = await createOrgSession("te-dupstep");
    const root = await seedRun({ orgId: org.orgId, status: "running" });
    const seeded = await insertStep({ runId: root, idx: 3, kind: "command", label: "grep", chip: null, code: { tool: "grep" } });

    const c = await open(`/api/runs/${root}/thread-events`, org.cookies);
    await c.waitFrame((f) => f.some((x) => x.event === "snapshot"));

    // Identical re-emit of a step already in the snapshot → suppressed.
    bus.emit(channel(root), { type: "step", step: seeded });
    // Enriched re-emit (same id/idx, new code_json) → passes.
    const enriched: ApiStep = { ...seeded, code_json: JSON.stringify({ tool: "grep", output: "match.ts" }) };
    bus.emit(channel(root), { type: "step", step: enriched });

    await c.waitFrame((f) => f.some((x) => x.event === "step" && x.data.step.code_json?.includes("match.ts")));
    const stepFrames = c.frames.filter((x) => x.event === "step" && x.data.step.id === seeded.id);
    expect(stepFrames.length).toBe(1); // only the enriched version, never the identical dup
    expect(stepFrames[0]!.data.step.code_json).toContain("match.ts");
  });

  test("replay/live overlap does not duplicate a native frame (eventId+seq dedupe)", async () => {
    const org = await createOrgSession("te-dupnative");
    const root = await seedRun({ orgId: org.orgId, status: "running" });
    await recordProviderEvent({ id: `${root}::n`, runId: root, threadId: root, provider: "opencode", eventType: "part.tool.running", nativePartId: "n", payload: { s: 0 } });

    const c = await open(`/api/runs/${root}/thread-events`, org.cookies);
    await c.waitFrame((f) => f.some((x) => x.event === "native" && x.data.frame.eventId === `${root}::n`));

    // Live re-publish of the SAME frame (eventId `${root}::n`, seq 0) → suppressed.
    publishNativeFrame(root, makeNativeFrame({ eventId: `${root}::n`, seq: 0, provider: "opencode", eventType: "part.tool.running", sessionId: null, parentSessionId: null, messageId: null, partId: "n", callId: null, payloadText: null }));
    // A revision (higher seq) → passes.
    publishNativeFrame(root, makeNativeFrame({ eventId: `${root}::n`, seq: 9, provider: "opencode", eventType: "part.tool.completed", sessionId: null, parentSessionId: null, messageId: null, partId: "n", callId: null, payloadText: null }));

    await c.waitFrame((f) => f.some((x) => x.event === "native" && x.data.frame.eventId === `${root}::n` && x.data.frame.seq === 9));
    const seq0 = c.frames.filter((x) => x.event === "native" && x.data.frame.eventId === `${root}::n` && x.data.frame.seq === 0);
    expect(seq0.length).toBe(1); // the replay only; the live dup was suppressed
  });

  test("`done` for one run does NOT close the stream; a queued run keeps streaming", async () => {
    const org = await createOrgSession("te-done");
    const root = await seedRun({ orgId: org.orgId, status: "running" });
    const queued = await seedRun({ orgId: org.orgId, threadId: root, parentRunId: root, status: "queued" });
    const c = await open(`/api/runs/${root}/thread-events`, org.cookies);
    await c.waitFrame((f) => f.some((x) => x.event === "snapshot"));

    // Settle the running run.
    bus.emit(channel(root), { type: "end", status: "completed" });
    await c.waitFrame((f) => f.some((x) => x.event === "done" && x.data.runId === root && x.data.status === "completed"));

    // The stream is still open: the queued run's live frames still arrive.
    publishNativeFrame(queued, makeNativeFrame({ eventId: `${queued}::after`, seq: 0, provider: "opencode", eventType: "part.text", sessionId: null, parentSessionId: null, messageId: null, partId: "after", callId: null, payloadText: null }));
    await c.waitFrame((f) => f.some((x) => x.event === "native" && x.data.runId === queued && x.data.frame.eventId === `${queued}::after`));
  });

  test("idempotent acceptance replay does not emit a second run entity", async () => {
    const org = await createOrgSession("te-idem");
    const root = await seedRun({ orgId: org.orgId, status: "running" });
    const c = await open(`/api/runs/${root}/thread-events`, org.cookies);
    await c.waitFrame((f) => f.some((x) => x.event === "snapshot"));

    const replyId = crypto.randomUUID();
    const run = {
      id: replyId, prompt: "keyed turn", model: "claude-opus-5", engine: "mock" as const,
      parentRunId: root, threadId: root, repos: [], memoryScope: "org" as const,
      skillId: null, skillVersion: null, skillContentHash: null,
    };
    const first = await acceptRunCommand({ idempotencyKey: "dup-key-1", orgId: org.orgId, actorId: null, run });
    const second = await acceptRunCommand({ idempotencyKey: "dup-key-1", orgId: org.orgId, actorId: null, run });
    expect(first.status).toBe("created");
    expect(second.status).toBe("replayed"); // no new run, no second signal

    await c.waitFrame((f) => f.some((x) => x.event === "run" && x.data.run.id === replyId));
    await new Promise((r) => setTimeout(r, 150)); // allow any stray second signal to arrive
    const runFrames = c.frames.filter((x) => x.event === "run" && x.data.run.id === replyId);
    // The created signal fires once; the replay fires none. (A `running`/`settled`
    // transition could add more, but none happens here — the run stays queued.)
    expect(runFrames.length).toBe(1);
  });

  test("disconnect removes the per-run bus listeners", async () => {
    const org = await createOrgSession("te-clean");
    const root = await seedRun({ orgId: org.orgId, status: "running" });
    const reply = await seedRun({ orgId: org.orgId, threadId: root, parentRunId: root, status: "queued" });
    const baseRoot = bus.listenerCount(channel(root));
    const baseReply = bus.listenerCount(channel(reply));

    const c = await openStream(`/api/runs/${root}/thread-events`, org.cookies);
    await c.waitFrame((f) => f.some((x) => x.event === "snapshot"));
    expect(bus.listenerCount(channel(root))).toBe(baseRoot + 1);
    expect(bus.listenerCount(channel(reply))).toBe(baseReply + 1);

    await c.close();
    await waitFor(async () =>
      bus.listenerCount(channel(root)) === baseRoot && bus.listenerCount(channel(reply)) === baseReply
        ? true
        : null,
    );
    expect(bus.listenerCount(channel(root))).toBe(baseRoot);
    expect(bus.listenerCount(channel(reply))).toBe(baseReply);
  });
});

describe("thread-events — post-open isolation (fail-closed after the stream is open)", () => {
  // Codex review finding 1: authorization must happen BEFORE attaching live
  // listeners, so a thread signal carrying a runId from a DIFFERENT thread/org can
  // never subscribe an open connection to that run's step/delta/native channels.
  // (The cross-org 404 test only covers OPENING a stream; this covers post-open
  // signal injection.) The pre-fix code reproduced leaked=true; these assert
  // leaked=false: the foreign run's listeners never bind and its frames never land.

  async function assertNoLeak(c: Awaited<ReturnType<typeof openStream>>, threadId: string, foreignRunId: string): Promise<void> {
    // Inject a signal on THIS thread's channel but with the foreign run's id, then
    // publish live frames for the foreign run through every lane.
    const baseBus = bus.listenerCount(channel(foreignRunId));
    publishThreadChange(threadId, { runId: foreignRunId, kind: "created" });
    await new Promise((r) => setTimeout(r, 120)); // let the signal drain through projectRun
    const step = await insertStep({ runId: foreignRunId, idx: 99, kind: "command", label: "leak", chip: null, code: { tool: "bash" } });
    bus.emit(channel(foreignRunId), { type: "step", step });
    turnStream.publish(foreignRunId, "leaked-delta");
    publishNativeFrame(foreignRunId, makeNativeFrame({ eventId: `${foreignRunId}::leak`, seq: 0, provider: "opencode", eventType: "part.text", sessionId: null, parentSessionId: null, messageId: null, partId: "leak", callId: null, payloadText: null }));
    await new Promise((r) => setTimeout(r, 200)); // give any (incorrect) leak time to arrive

    const leaked = c.frames.filter(
      (x) =>
        (x.event === "run" && x.data.run?.id === foreignRunId) ||
        (x.event !== "snapshot" && x.data?.runId === foreignRunId),
    );
    expect(leaked.length).toBe(0); // leaked=false
    // The foreign run's live listeners never bound (auth ran before attach).
    expect(bus.listenerCount(channel(foreignRunId))).toBe(baseBus);
  }

  test("same-org, different-thread run id does not leak onto an open stream", async () => {
    const org = await createOrgSession("te-iso-samethread");
    const rootA = await seedRun({ orgId: org.orgId, status: "running" });
    const rootB = await seedRun({ orgId: org.orgId, status: "running" }); // separate thread, same org
    const c = await open(`/api/runs/${rootA}/thread-events`, org.cookies);
    await c.waitFrame((f) => f.some((x) => x.event === "snapshot"));
    await assertNoLeak(c, rootA, rootB);
  });

  test("cross-org run id does not leak onto an open stream", async () => {
    const orgA = await createOrgSession("te-iso-a");
    const orgB = await createOrgSession("te-iso-b");
    const rootA = await seedRun({ orgId: orgA.orgId, status: "running" });
    const rootB = await seedRun({ orgId: orgB.orgId, status: "running" }); // OTHER org
    const c = await open(`/api/runs/${rootA}/thread-events`, orgA.cookies);
    await c.waitFrame((f) => f.some((x) => x.event === "snapshot"));
    await assertNoLeak(c, rootA, rootB);
  });
});

// ── Resume cursor: a browser that already holds part of the thread asks only for the
//    canonical rows above its cursor; a cursor from another process, or whose row is
//    not here with the same id, is refused. Native frames always replay from zero.
describe("thread-events — resume cursor", () => {
  async function seedResumable() {
    const org = await createOrgSession();
    const root = await seedRun({ orgId: org.orgId, status: "completed" });
    for (const i of [0, 1, 2]) {
      await recordProviderEvent({ id: `${root}::n${i}`, runId: root, threadId: root, provider: "opencode", eventType: "part.tool.completed", nativePartId: `n${i}`, payload: { i } });
    }
    const frames: OpenCodeFrame[] = [0, 1, 2].map((i) => ({
      eventId: `${root}-c${i}`, seq: i, provider: "opencode", eventType: "part.text",
      native: { sessionId: "ses", parentSessionId: null, messageId: `${root}-m`, partId: `${root}-p${i}`, callId: null }, payload: { text: `c${i}` },
    }));
    const delivered = (await persistAndPublish(translateOpenCode(frames, { runId: root, threadId: root }).events))
      .toSorted((a, b) => a.deliverySeq - b.deliverySeq);
    return { org, root, seqs: delivered.map((d) => d.deliverySeq), ids: delivered.map((d) => d.eventId) };
  }
  const nativeSeqs = (c: StreamClient, runId: string): number[] =>
    c.frames.filter((f) => f.event === "native" && f.data.runId === runId).map((f) => f.data.frame.seq as number);
  const canonicalSeqs = (c: StreamClient): number[] =>
    c.frames.filter((f) => f.event === "canonical").map((f) => f.data.event.deliverySeq as number);
  const eventIndex = (c: StreamClient, event: string): number => c.frames.findIndex((f) => f.event === event);
  const q = (params: Record<string, string>): string => new URLSearchParams(params).toString();

  test("without a cursor the first frame is a from-zero resume carrying this process's epoch, and everything replays", async () => {
    const { org, root, seqs } = await seedResumable();
    const c = await open(`/api/runs/${root}/thread-events`, org.cookies);
    await c.waitFrame(() => canonicalSeqs(c).length === seqs.length);
    expect(c.frames[0]).toMatchObject({ event: "resume", data: { threadId: root, resume: { canonicalAfter: 0, reset: false, epoch: STREAM_EPOCH } } });
    expect(nativeSeqs(c, root)).toEqual([0, 1, 2]);
    expect(canonicalSeqs(c)).toEqual(seqs);
  });

  test("an honoured cursor replays every native frame but only the newer canonical rows, in the documented order", async () => {
    const { org, root, seqs, ids } = await seedResumable();
    const c = await open(`/api/runs/${root}/thread-events?${q({ canonicalAfter: String(seqs[1]), canonicalId: ids[1]!, epoch: STREAM_EPOCH })}`, org.cookies);
    await c.waitFrame((f) => f.some((x) => x.event === "canonical-complete") || canonicalSeqs(c).length > 0);
    await c.waitFrame((f) => f.some((x) => x.event === "canonical" && x.data.event.deliverySeq === seqs[2]));
    expect(c.frames[0]).toMatchObject({ event: "resume", data: { resume: { canonicalAfter: seqs[1], reset: false } } });
    expect(nativeSeqs(c, root)).toEqual([0, 1, 2]);
    expect(canonicalSeqs(c)).toEqual([seqs[2]]);
    expect(eventIndex(c, "resume")).toBeLessThan(eventIndex(c, "snapshot"));
    expect(eventIndex(c, "snapshot")).toBeLessThan(eventIndex(c, "native"));
    expect(eventIndex(c, "native")).toBeLessThan(eventIndex(c, "canonical"));
  });

  for (const [name, params] of [
    ["a cursor above the durable state", (seqs: number[], ids: string[]) => ({ canonicalAfter: String(seqs[2]! + 1000), canonicalId: ids[2]!, epoch: STREAM_EPOCH })],
    ["a cursor whose row carries another event id", (seqs: number[]) => ({ canonicalAfter: String(seqs[1]), canonicalId: "from-a-restored-database", epoch: STREAM_EPOCH })],
    ["a cursor minted by another backend process", (seqs: number[], ids: string[]) => ({ canonicalAfter: String(seqs[1]), canonicalId: ids[1]!, epoch: "some-earlier-boot" })],
  ] as const) {
    test(`${name} is refused: reset + from-zero replay`, async () => {
      const { org, root, seqs, ids } = await seedResumable();
      const c = await open(`/api/runs/${root}/thread-events?${q(params(seqs, ids))}`, org.cookies);
      await c.waitFrame(() => canonicalSeqs(c).length === seqs.length);
      expect(c.frames[0]).toMatchObject({ event: "resume", data: { resume: { canonicalAfter: 0, reset: true } } });
      expect(canonicalSeqs(c)).toEqual(seqs);
    });
  }

  test("a malformed or incomplete cursor reads as absent", async () => {
    const { org, root, seqs, ids } = await seedResumable();
    const c = await open(`/api/runs/${root}/thread-events?${q({ canonicalAfter: String(seqs[1]), canonicalId: ids[1]! })}`, org.cookies);
    await c.waitFrame(() => canonicalSeqs(c).length === seqs.length);
    expect(c.frames[0]!.data.resume).toMatchObject({ canonicalAfter: 0, reset: false });
    const d = await open(`/api/runs/${root}/thread-events?${q({ canonicalAfter: "-5", canonicalId: ids[1]!, epoch: STREAM_EPOCH })}`, org.cookies);
    await d.waitFrame(() => canonicalSeqs(d).length === seqs.length);
    expect(d.frames[0]!.data.resume).toMatchObject({ canonicalAfter: 0, reset: false });
  });

  test("completion records follow the canonical rows on every connection", async () => {
    const { org, root } = await seedResumable();
    await db.insert(canonicalizationOutbox).values({ runId: root, threadId: root, state: "complete", sourceFrameMax: 2, sourceStepCount: 0 }).onConflictDoNothing();
    const c = await open(`/api/runs/${root}/thread-events`, org.cookies);
    await c.waitFrame((f) => f.some((x) => x.event === "canonical-complete"));
    expect(eventIndex(c, "canonical")).toBeLessThan(eventIndex(c, "canonical-complete"));
    expect(c.frames.filter((x) => x.event === "canonical").length).toBe(3);
  });

  // ── Native cursors: a browser that holds a SEALED run up to the seal's watermark asks
  //    for only what is newer; every other case replays the run's native frames from zero.
  async function seedSealed(sourceFrameMax = 2) {
    const seeded = await seedResumable();
    await db.insert(canonicalizationOutbox).values({ runId: seeded.root, threadId: seeded.root, state: "complete", sourceFrameMax, sourceStepCount: 0 }).onConflictDoNothing();
    return seeded;
  }
  const settled = (c: StreamClient): Promise<void> => c.waitFrame((f) => f.some((x) => x.event === "canonical-complete"));
  /** What a browser reports after retaining frames n0..n<upTo> of a seeded run: `<seq>:<digest>`. */
  const holdFor = (root: string, upTo: number): string =>
    `${upTo}:${nativeHoldDigest(Array.from({ length: upTo + 1 }, (_, i) => ({ eventId: `${root}::n${i}`, seq: i })))}`;

  test("a native cursor at the seal watermark replays only the frames written after it", async () => {
    const { org, root, seqs, ids } = await seedSealed();
    // A frame landed after the seal (an artifact receipt, a follow-up): seq 3, above the watermark.
    await recordProviderEvent({ id: `${root}::late`, runId: root, threadId: root, provider: PLATFORM_EVENT_LANES.platform, eventType: "followups.suggested", nativePartId: "late", payload: { suggestions: [] } });
    const c = await open(`/api/runs/${root}/thread-events?${q({ canonicalAfter: String(seqs[2]), canonicalId: ids[2]!, epoch: STREAM_EPOCH })}&nativeAfter=${root}:${holdFor(root, 2)}`, org.cookies);
    await settled(c);
    expect(c.frames[0]).toMatchObject({ event: "resume", data: { resume: { canonicalAfter: seqs[2], reset: false } } });
    expect(nativeSeqs(c, root)).toEqual([3]);
    expect(canonicalSeqs(c)).toEqual([]);
  });

  test("a native cursor without a canonical cursor is still honoured on this process's epoch", async () => {
    const { org, root } = await seedSealed();
    const c = await open(`/api/runs/${root}/thread-events?epoch=${STREAM_EPOCH}&nativeAfter=${root}:${holdFor(root, 2)}`, org.cookies);
    await settled(c);
    expect(nativeSeqs(c, root)).toEqual([]);
    expect(c.frames.filter((x) => x.event === "canonical").length).toBe(3);
  });

  const otherHold = `2:${nativeHoldDigest([{ eventId: "some-other-run::n0", seq: 0 }])}`;
  for (const [name, setup] of [
    ["below the seal watermark", async () => ({ ...(await seedSealed(2)), upTo: 1, epoch: STREAM_EPOCH })],
    ["for a run that is not sealed", async () => ({ ...(await seedResumable()), upTo: 2, epoch: STREAM_EPOCH })],
    ["minted by another backend process", async () => ({ ...(await seedSealed(2)), upTo: 2, epoch: "some-earlier-boot" })],
    ["sent without an epoch", async () => ({ ...(await seedSealed(2)), upTo: 2, epoch: "" })],
    ["with the digest of another hold", async () => ({ ...(await seedSealed(2)), upTo: null, epoch: STREAM_EPOCH })],
  ] as const) {
    test(`a native cursor ${name} is ignored: the run replays from zero`, async () => {
      const { org, root, upTo, epoch } = await setup();
      const hold = upTo === null ? otherHold : holdFor(root, upTo);
      const c = await open(`/api/runs/${root}/thread-events?${q(epoch ? { epoch } : {})}&nativeAfter=${root}:${hold}`, org.cookies);
      await c.waitFrame(() => canonicalSeqs(c).length === 3);
      expect(nativeSeqs(c, root)).toEqual([0, 1, 2]);
    });
  }

  // The seal drains only this process's writes: the gateway process allocates its own
  // seqs, so a frame can commit BELOW the browser's cursor after the run sealed, and a
  // watermark check alone would skip it forever. The hold digest catches it, and so does
  // a revision that moved a frame even when another frame took its old seq.
  test("a frame the other writer committed below the cursor after the seal sends the run back to a full replay", async () => {
    const { org, root } = await seedSealed();
    await db.insert(providerEvents).values({ id: `${root}::late-low`, runId: root, threadId: root, seq: 1, provider: PLATFORM_EVENT_LANES.memory, eventType: "memory.recalled", payload: "{}" });
    const c = await open(`/api/runs/${root}/thread-events?epoch=${STREAM_EPOCH}&nativeAfter=${root}:${holdFor(root, 2)}`, org.cookies);
    await settled(c);
    expect(nativeSeqs(c, root)).toEqual([0, 1, 1, 2]);
  });

  test("a frame re-sequenced below the cursor (same count, other seqs) sends the run back to a full replay", async () => {
    const { org, root } = await seedSealed();
    await db.update(providerEvents).set({ seq: 0 }).where(eq(providerEvents.id, `${root}::n2`));
    const c = await open(`/api/runs/${root}/thread-events?epoch=${STREAM_EPOCH}&nativeAfter=${root}:${holdFor(root, 2)}`, org.cookies);
    await settled(c);
    expect(nativeSeqs(c, root)).toEqual([0, 0, 1]);
  });

  test("a revision that moved a frame while another frame took its old seq (same count, same seq total) sends the run back to a full replay", async () => {
    const { org, root } = await seedSealed();
    await db.update(providerEvents).set({ seq: 3 }).where(eq(providerEvents.id, `${root}::n2`));
    await db.insert(providerEvents).values({ id: `${root}::g`, runId: root, threadId: root, seq: 2, provider: PLATFORM_EVENT_LANES.memory, eventType: "memory.recalled", payload: "{}" });
    const c = await open(`/api/runs/${root}/thread-events?epoch=${STREAM_EPOCH}&nativeAfter=${root}:${holdFor(root, 2)}`, org.cookies);
    await settled(c);
    expect(nativeSeqs(c, root)).toEqual([0, 1, 2, 3]);
  });

  test("a frame the other writer commits below the cursor after the connection opened arrives with the next thread signal", async () => {
    const { org, root } = await seedSealed();
    const c = await open(`/api/runs/${root}/thread-events?epoch=${STREAM_EPOCH}&nativeAfter=${root}:${holdFor(root, 2)}`, org.cookies);
    await settled(c);
    expect(nativeSeqs(c, root)).toEqual([]);
    await db.insert(providerEvents).values({ id: `${root}::late-low`, runId: root, threadId: root, seq: 1, provider: PLATFORM_EVENT_LANES.memory, eventType: "memory.recalled", payload: "{}" });
    publishThreadChange(root, { runId: root, kind: "settled" });
    await c.waitFrame((f) => f.some((x) => x.event === "native" && x.data.frame.eventId === `${root}::late-low`));
    // Only the new frame: the pairs the browser proved it holds are never resent.
    expect(nativeSeqs(c, root)).toEqual([1]);
  });

  test("a refused canonical cursor resets the connection and the native cursors with it", async () => {
    const { org, root, seqs, ids } = await seedSealed();
    const c = await open(`/api/runs/${root}/thread-events?${q({ canonicalAfter: String(seqs[1]), canonicalId: ids[1]!, epoch: "some-earlier-boot" })}&nativeAfter=${root}:${holdFor(root, 2)}`, org.cookies);
    await settled(c);
    expect(c.frames[0]).toMatchObject({ event: "resume", data: { resume: { canonicalAfter: 0, reset: true } } });
    expect(nativeSeqs(c, root)).toEqual([0, 1, 2]);
  });

  test("a live re-projection of a resumed run does not resend the frames the browser holds", async () => {
    const { org, root } = await seedSealed();
    const c = await open(`/api/runs/${root}/thread-events?epoch=${STREAM_EPOCH}&nativeAfter=${root}:${holdFor(root, 2)}`, org.cookies);
    await settled(c);
    // The thread signal re-projects the run (a settled refresh): the durable `run` frame
    // is re-sent, the native frames below the browser's cursor are not.
    publishThreadChange(root, { runId: root, kind: "settled" });
    await c.waitFrame((f) => f.filter((x) => x.event === "run" && x.data.run.id === root).length >= 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(nativeSeqs(c, root)).toEqual([]);
  });
});
