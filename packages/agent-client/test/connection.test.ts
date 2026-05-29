// Deterministic tests for the thread SSE connection controller (Codex finding 3).
// A fake EventSource + a manual clock drive the reconnect / health / fallback-poll
// state machine with zero real time or network.

import { describe, expect, test } from "bun:test";
import { createThreadConnection, type EventSourceLike, type TimerHost } from "../src/connection";

class Clock {
  now = 0;
  private seq = 0;
  private timeouts = new Map<number, { due: number; fn: () => void }>();
  private intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  host: TimerHost = {
    setTimeout: (fn, ms) => { const id = ++this.seq; this.timeouts.set(id, { due: this.now + ms, fn }); return id; },
    clearTimeout: (t) => { this.timeouts.delete(t as number); },
    setInterval: (fn, ms) => { const id = ++this.seq; this.intervals.set(id, { every: ms, next: this.now + ms, fn }); return id; },
    clearInterval: (t) => { this.intervals.delete(t as number); },
  };
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let earliest = Infinity, kind = "", id = -1;
      for (const [i, t] of this.timeouts) if (t.due <= target && t.due < earliest) { earliest = t.due; kind = "to"; id = i; }
      for (const [i, iv] of this.intervals) if (iv.next <= target && iv.next < earliest) { earliest = iv.next; kind = "iv"; id = i; }
      if (earliest === Infinity) break;
      this.now = earliest;
      if (kind === "to") {
        const timeout = this.timeouts.get(id);
        if (!timeout) throw new Error(`missing timeout ${id}`);
        this.timeouts.delete(id);
        timeout.fn();
      } else {
        const interval = this.intervals.get(id);
        if (!interval) throw new Error(`missing interval ${id}`);
        interval.next += interval.every;
        interval.fn();
      }
    }
    this.now = target;
  }
  timeoutCount(): number { return this.timeouts.size; }
  intervalCount(): number { return this.intervals.size; }
}

class FakeES implements EventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  addEventListener(type: string, fn: (e: { data: string }) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  close(): void { this.closed = true; }
  emit(type: string, data: string): void { for (const l of this.listeners.get(type) ?? []) l({ data }); }
}

function expectSource(sources: readonly FakeES[], index: number): FakeES {
  const source = sources[index];
  if (!source) throw new Error(`expected source ${index}`);
  return source;
}

function harness(opts: {
  failCreates?: number;
  reconcileSettlement?: (runId: string) => Promise<boolean>;
  settlementAttempts?: number;
} = {}) {
  const clock = new Clock();
  const sources: FakeES[] = [];
  const frames: { event: string; data: string }[] = [];
  let polls = 0;
  let creates = 0;
  const conn = createThreadConnection({
    url: "/api/runs/root/thread-events",
    frameTypes: ["snapshot", "run", "step", "delta", "native", "done"],
    healthFrame: "snapshot",
    createEventSource: () => {
      creates += 1;
      if (opts.failCreates && creates <= opts.failCreates) throw new Error("construct fail");
      const es = new FakeES();
      sources.push(es);
      return es;
    },
    onFrame: (event, data) => frames.push({ event, data }),
    poll: () => { polls += 1; },
    reconcileSettlement: opts.reconcileSettlement,
    settlementAttempts: opts.settlementAttempts,
    timers: clock.host,
    maxAttempts: 5,
    healthyMs: 3000,
    pollMs: 5000,
  });
  const last = () => expectSource(sources, sources.length - 1);
  const openThenError = () => { last().onopen?.(); last().onerror?.(); };
  return { clock, sources, frames, conn, get polls() { return polls; }, get creates() { return creates; }, last, openThenError };
}

describe("thread-connection", () => {
  test("five open-then-error cycles activate exactly ONE fallback poll", () => {
    const h = harness();
    h.conn.start(); // source 0
    h.openThenError(); // attempts=1, reconnect@1000
    for (let i = 2; i <= 5; i++) {
      h.clock.advance(6000); // fire the scheduled reconnect (backoff <= 5000)
      h.openThenError(); // attempts=i
    }
    expect(h.conn.isPolling()).toBe(true); // poll engaged at attempt 5
    expect(h.clock.intervalCount()).toBe(1); // exactly one poll interval
    // Only one live source at a time (each connect closes the prior).
    const open = h.sources.filter((s) => !s.closed).length;
    expect(open).toBeLessThanOrEqual(1);
  });

  test("a snapshot frame resets failures and stops the fallback poll (never both run)", () => {
    const h = harness();
    h.conn.start();
    h.openThenError();
    for (let i = 2; i <= 5; i++) { h.clock.advance(6000); h.openThenError(); }
    expect(h.conn.isPolling()).toBe(true);

    // A healthy reconnect delivers a snapshot → markHealthy stops the poll immediately.
    h.clock.advance(6000); // reconnect → fresh source
    h.last().onopen?.();
    h.last().emit("snapshot", '{"runs":[]}');
    expect(h.conn.isPolling()).toBe(false); // poll stopped the instant SSE is healthy
    expect(h.clock.intervalCount()).toBe(0);
    // A later poll tick can't fire (interval cleared): advancing does not increment polls.
    const before = h.polls;
    h.clock.advance(20000);
    expect(h.polls).toBe(before);
  });

  test("staying open for healthyMs (no snapshot) also resets failures", () => {
    const h = harness();
    h.conn.start();
    h.openThenError();
    for (let i = 2; i <= 5; i++) { h.clock.advance(6000); h.openThenError(); }
    expect(h.conn.isPolling()).toBe(true);
    h.clock.advance(6000); // reconnect → fresh source
    h.last().onopen?.(); // health timer armed at now+3000
    h.clock.advance(3000); // stays open → markHealthy
    expect(h.conn.isPolling()).toBe(false);
  });

  test("a constructor throw still schedules an SSE retry (not just polling)", () => {
    const h = harness({ failCreates: 1 }); // first createEventSource throws
    h.conn.start();
    expect(h.creates).toBe(1);
    expect(h.sources.length).toBe(0); // no source yet
    expect(h.conn.isPolling()).toBe(false); // one failure < max → no poll yet
    expect(h.clock.timeoutCount()).toBe(1); // an SSE reconnect IS scheduled
    h.clock.advance(6000); // retry → this time construction succeeds
    expect(h.sources.length).toBe(1); // recovered via SSE, not stuck on polling
  });

  test("stop() closes the source and cancels every timer", () => {
    const h = harness();
    h.conn.start();
    h.last().onopen?.(); // arms a health timer
    h.conn.stop();
    expect(h.last().closed).toBe(true);
    expect(h.clock.timeoutCount()).toBe(0);
    expect(h.clock.intervalCount()).toBe(0);
    expect(h.conn.isPolling()).toBe(false);
    // Nothing fires after stop.
    const framesBefore = h.frames.length, pollsBefore = h.polls;
    h.clock.advance(60000);
    expect(h.frames.length).toBe(framesBefore);
    expect(h.polls).toBe(pollsBefore);
  });

  test("frames are delivered to onFrame with event name + data", () => {
    const h = harness();
    h.conn.start();
    h.last().emit("run", '{"run":{"id":"r1"}}');
    h.last().emit("native", '{"runId":"r1"}');
    expect(h.frames).toEqual([
      { event: "run", data: '{"run":{"id":"r1"}}' },
      { event: "native", data: '{"runId":"r1"}' },
    ]);
  });

  test("healthy SSE performs no durable settlement requests without terminal evidence", async () => {
    let reconciliations = 0;
    const h = harness({
      reconcileSettlement: async () => {
        reconciliations += 1;
        return true;
      },
    });
    h.conn.start();
    h.last().onopen?.();
    h.last().emit("snapshot", '{"runs":[{"id":"r1","status":"running"}]}');
    h.clock.advance(60_000);
    await Promise.resolve();

    expect(reconciliations).toBe(0);
  });

  test("terminal evidence recovers a missed settled projection with bounded verification", async () => {
    let reconciliations = 0;
    const reconciledRuns: string[] = [];
    const h = harness({
      reconcileSettlement: async (runId) => {
        reconciliations += 1;
        reconciledRuns.push(runId);
        return reconciliations === 2;
      },
    });
    h.conn.start();
    h.conn.requestSettlementReconcile("run-1");
    await Promise.resolve();
    expect(reconciliations).toBe(1);
    expect(h.clock.timeoutCount()).toBe(1);

    h.clock.advance(1_000);
    await Promise.resolve();
    expect(reconciliations).toBe(2);
    expect(reconciledRuns).toEqual(["run-1", "run-1"]);
    expect(h.clock.timeoutCount()).toBe(0);
  });

  test("backend-down settlement verification exhausts its budget and stop cancels retries", async () => {
    let reconciliations = 0;
    const h = harness({
      reconcileSettlement: async () => {
        reconciliations += 1;
        return false;
      },
      settlementAttempts: 2,
    });
    h.conn.start();
    h.conn.requestSettlementReconcile("run-1");
    await Promise.resolve();
    expect(reconciliations).toBe(1);

    h.clock.advance(1_000);
    await Promise.resolve();
    expect(reconciliations).toBe(2);
    expect(h.clock.timeoutCount()).toBe(0);

    h.conn.requestSettlementReconcile("run-1");
    await Promise.resolve();
    expect(reconciliations).toBe(3);
    expect(h.clock.timeoutCount()).toBe(1);
    h.conn.stop();
    h.clock.advance(60_000);
    expect(reconciliations).toBe(3);
  });

  test("re-evaluates URL callbacks for each reconnect", () => {
    const clock = new Clock();
    const urls: string[] = [];
    const sources: FakeES[] = [];
    let cursor = -1;
    const conn = createThreadConnection({
      url: () => `/api/runs/root/events?cursor=${cursor}`,
      frameTypes: ["step"],
      healthFrame: "step",
      createEventSource: (url) => {
        urls.push(url);
        const source = new FakeES();
        sources.push(source);
        return source;
      },
      onFrame: () => {},
      poll: () => {},
      timers: clock.host,
      backoff: () => 1000,
    });

    conn.start();
    cursor = 41;
    expectSource(sources, 0).onerror?.();
    clock.advance(1000);

    expect(urls).toEqual([
      "/api/runs/root/events?cursor=-1",
      "/api/runs/root/events?cursor=41",
    ]);
    conn.stop();
  });
});

describe("thread-connection: stale-callback generation guard", () => {
  test("a REPLACED source's frame is ignored; only the current source delivers", () => {
    const h = harness();
    h.conn.start(); // source 0
    h.openThenError(); // onFailure → close source 0, schedule reconnect
    h.clock.advance(6000); // reconnect → source 1 (current)
    expect(h.sources.length).toBe(2);

    // The OLD source 0 fires a buffered frame AFTER being replaced - it must be ignored.
    expectSource(h.sources, 0).emit("run", '{"run":{"id":"stale"}}');
    expect(h.frames).toEqual([]); // stale frame dropped by the generation guard

    // The CURRENT source still delivers normally.
    expectSource(h.sources, 1).emit("run", '{"run":{"id":"fresh"}}');
    expect(h.frames).toEqual([{ event: "run", data: '{"run":{"id":"fresh"}}' }]);
  });

  test("a REPLACED source's snapshot cannot falsely mark healthy / stop the fallback poll", () => {
    const h = harness();
    h.conn.start();
    h.openThenError();
    for (let i = 2; i <= 5; i++) { h.clock.advance(6000); h.openThenError(); }
    expect(h.conn.isPolling()).toBe(true); // fallback engaged
    h.clock.advance(6000); // reconnect → a fresh current source
    const staleSource = expectSource(h.sources, 0);

    // A stale snapshot from the replaced source must NOT reset failures or stop the poll.
    staleSource.emit("snapshot", '{"runs":[]}');
    expect(h.conn.isPolling()).toBe(true); // still polling - the stale health frame was ignored

    // A snapshot from the CURRENT source does stop the poll.
    h.last().emit("snapshot", '{"runs":[]}');
    expect(h.conn.isPolling()).toBe(false);
  });

  test("onopen/onerror are detached on a replaced source (no stale open/error path)", () => {
    const h = harness();
    h.conn.start(); // source 0
    h.openThenError();
    h.clock.advance(6000); // reconnect → source 1
    const replaced = expectSource(h.sources, 0);
    expect(replaced.onopen).toBeNull();
    expect(replaced.onerror).toBeNull();
    // Even if a caller force-invokes the old callbacks, the guard makes them inert:
    // there is exactly one health/reconnect timer regardless.
    const timers = h.clock.timeoutCount();
    replaced.onopen?.(); // null -> no-op; guard would also block it
    expect(h.clock.timeoutCount()).toBe(timers);
  });
});
