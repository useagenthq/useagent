import { describe, expect, it } from "bun:test";
import { createTurnStream } from "./turn-stream";

const R = "run-1";

describe("turn-stream", () => {
  it("accumulates published deltas into the snapshot", () => {
    const ts = createTurnStream();
    expect(ts.snapshot(R)).toBeNull();
    ts.publish(R, "Hello");
    ts.publish(R, ", world");
    expect(ts.snapshot(R)).toBe("Hello, world");
  });

  it("delivers each delta to subscribers in publish order", () => {
    const ts = createTurnStream();
    const got: string[] = [];
    ts.subscribe(R, (d) => got.push(d));
    ts.publish(R, "a");
    ts.publish(R, "b");
    ts.publish(R, "c");
    expect(got).toEqual(["a", "b", "c"]);
  });

  it("fans out to every subscriber", () => {
    const ts = createTurnStream();
    const a: string[] = [];
    const b: string[] = [];
    ts.subscribe(R, (d) => a.push(d));
    ts.subscribe(R, (d) => b.push(d));
    ts.publish(R, "x");
    expect(a).toEqual(["x"]);
    expect(b).toEqual(["x"]);
  });

  it("ignores empty deltas (no snapshot, no notification)", () => {
    const ts = createTurnStream();
    const got: string[] = [];
    ts.subscribe(R, (d) => got.push(d));
    ts.publish(R, "");
    expect(got).toEqual([]);
    expect(ts.snapshot(R)).toBeNull();
  });

  it("caps the buffered text at maxChars", () => {
    const ts = createTurnStream({ maxChars: 5 });
    ts.publish(R, "abc");
    ts.publish(R, "defgh"); // would exceed 5 — buffer stops growing past the cap
    expect(ts.snapshot(R)!.length).toBe(5);
    expect(ts.snapshot(R)).toBe("abcde");
  });

  it("stops delivering after unsubscribe and prunes the listener set", () => {
    const ts = createTurnStream();
    const got: string[] = [];
    const off = ts.subscribe(R, (d) => got.push(d));
    ts.publish(R, "1");
    off();
    ts.publish(R, "2");
    expect(got).toEqual(["1"]);
    // A fresh subscriber still works (set was recreated, not leaked).
    const later: string[] = [];
    ts.subscribe(R, (d) => later.push(d));
    ts.publish(R, "3");
    expect(later).toEqual(["3"]);
  });

  it("tracks liveness across begin / publish / end", () => {
    const ts = createTurnStream();
    expect(ts.alive(R)).toBe(false);
    ts.begin(R);
    expect(ts.alive(R)).toBe(true);
    ts.end(R);
    expect(ts.alive(R)).toBe(false);
    // publish revives liveness even after end().
    ts.publish(R, "z");
    expect(ts.alive(R)).toBe(true);
  });

  it("evicts a run's buffer a grace period after end()", async () => {
    const ts = createTurnStream({ graceMs: 15 });
    ts.publish(R, "keep-for-now");
    ts.end(R);
    expect(ts.snapshot(R)).toBe("keep-for-now"); // still available during grace
    await Bun.sleep(40);
    expect(ts.snapshot(R)).toBeNull(); // evicted
  });

  it("a delta after end() cancels the pending eviction", async () => {
    const ts = createTurnStream({ graceMs: 15 });
    ts.publish(R, "one");
    ts.end(R);
    ts.publish(R, "-two"); // revives, clears the grace timer
    await Bun.sleep(40);
    expect(ts.snapshot(R)).toBe("one-two"); // survived past graceMs
  });

  it("begin() after end() cancels the pending eviction", async () => {
    const ts = createTurnStream({ graceMs: 15 });
    ts.publish(R, "payload");
    ts.end(R);
    ts.begin(R); // reopen before grace elapses
    await Bun.sleep(40);
    expect(ts.snapshot(R)).toBe("payload");
    expect(ts.alive(R)).toBe(true);
  });

  it("isolates buffers and subscribers per run id", () => {
    const ts = createTurnStream();
    const a: string[] = [];
    const b: string[] = [];
    ts.subscribe("run-a", (d) => a.push(d));
    ts.subscribe("run-b", (d) => b.push(d));
    ts.publish("run-a", "AA");
    ts.publish("run-b", "BB");
    expect(a).toEqual(["AA"]);
    expect(b).toEqual(["BB"]);
    expect(ts.snapshot("run-a")).toBe("AA");
    expect(ts.snapshot("run-b")).toBe("BB");
  });
});
