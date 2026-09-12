import { describe, expect, test } from "bun:test";
import { admitCanonicalComplete, type CanonicalizationComplete } from "../src/runs/canonical-events";
import "./helpers";

const complete = (degraded: boolean): CanonicalizationComplete => ({
  runId: "run-1", threadId: "thread-1", sourceFrameMax: 2, sourceStepCount: 1, degraded, lostFrames: degraded ? 1 : 0,
});

describe("thread stream completion dedupe", () => {
  test("announces a run once, admits the one clean-to-degraded correction, and drops every repeat", () => {
    const seen = new Map<string, boolean>();
    expect(admitCanonicalComplete(seen, complete(false))).toBe(true);
    expect(admitCanonicalComplete(seen, complete(false))).toBe(false); // replay + live of the same clean seal
    expect(admitCanonicalComplete(seen, complete(true))).toBe(true); // the correction
    expect(admitCanonicalComplete(seen, complete(true))).toBe(false); // a repeated correction
    expect(admitCanonicalComplete(seen, complete(false))).toBe(false); // a stale clean frame never clears it
  });

  test("a run first seen degraded is announced once", () => {
    const seen = new Map<string, boolean>();
    expect(admitCanonicalComplete(seen, complete(true))).toBe(true);
    expect(admitCanonicalComplete(seen, complete(true))).toBe(false);
    expect(admitCanonicalComplete(seen, complete(false))).toBe(false);
  });
});
