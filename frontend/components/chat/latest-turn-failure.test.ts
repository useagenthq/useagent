import { describe, expect, test } from "bun:test";

// The conversation module reads the canonical-timeline flag at load; agree with
// the other suites before the first import so the module cache stays coherent.
process.env.NEXT_PUBLIC_CANONICAL_TIMELINE = "1";
const { latestTurnFailure } = await import("./conversation");
type Turn = import("./conversation").Turn;

function turn(id: string, status: Turn["status"], summary: string | null): Turn {
  return { run: { id }, status, summary } as unknown as Turn;
}

describe("latestTurnFailure - the failure banner follows the thread's latest turn", () => {
  const failed = turn("r1", "failed", "Sandbox resources are below the required target");

  test("a failed latest turn raises the banner with its summary", () => {
    expect(latestTurnFailure([failed], false)?.run.id).toBe("r1");
  });

  test("a later successful turn retires an earlier failure", () => {
    expect(latestTurnFailure([failed, turn("r2", "completed", "Done")], false)).toBeUndefined();
  });

  test("no banner while a turn runs, or for a failure with nothing to say", () => {
    expect(latestTurnFailure([failed], true)).toBeUndefined();
    expect(latestTurnFailure([turn("r3", "failed", null)], false)).toBeUndefined();
  });
});
