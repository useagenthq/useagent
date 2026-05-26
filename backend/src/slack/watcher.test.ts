/**
 * Pure throttle test for the Slack progress watcher. `createProgressThrottle`
 * gates live card/shimmer updates to at most once per min-gap, coalescing a burst
 * of step events so a chatty run never spams Slack. No I/O, no live run.
 */
import { describe, expect, test } from "bun:test";
import { createProgressThrottle } from "./watcher";

describe("createProgressThrottle", () => {
  test("allows the first update immediately", () => {
    const t = createProgressThrottle(2000);
    expect(t.allow(0)).toBe(true);
  });

  test("suppresses updates within the min-gap window (coalesced)", () => {
    const t = createProgressThrottle(2000);
    expect(t.allow(1000)).toBe(true); // first
    expect(t.allow(1500)).toBe(false); // 500ms later - throttled
    expect(t.allow(2999)).toBe(false); // 1999ms later - still throttled
  });

  test("allows again once the gap elapses, and re-arms from the emitted time", () => {
    const t = createProgressThrottle(2000);
    expect(t.allow(1000)).toBe(true);
    expect(t.allow(3000)).toBe(true); // exactly 2000ms later
    expect(t.allow(3500)).toBe(false); // throttled again from 3000
    expect(t.allow(5000)).toBe(true);
  });

  test("a burst of events collapses to bounded emissions", () => {
    const t = createProgressThrottle(2000);
    let emitted = 0;
    // 100 events over 10s at 100ms spacing -> at most ceil(10000/2000)+1 = 6.
    for (let now = 0; now < 10_000; now += 100) if (t.allow(now)) emitted++;
    expect(emitted).toBeLessThanOrEqual(6);
    expect(emitted).toBeGreaterThan(0);
  });
});
