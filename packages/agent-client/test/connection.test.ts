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
      if (kind === "to") { const t = this.timeouts.get(id)!; this.timeouts.delete(id); t.fn(); }
      else { const iv = this.intervals.get(id)!; iv.next += iv.every; iv.fn(); }
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

function harness(opts: { failCreates?: number } = {}) {
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
    timers: clock.host,
    maxAttempts: 5,
    healthyMs: 3000,
    pollMs: 5000,
  });
  const last = () => sources[sources.length - 1]!;
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
});
