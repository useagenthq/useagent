// Pure decision logic for the memory capture outbox (Phase 3b). The DB paths
// (enqueue/claim/deliver) are covered by the live enqueue→deliver→dead-letter
// proof; here we lock the retry/dead policy + backoff curve deterministically.
import { describe, expect, test } from "bun:test";
import { backoffAt, nextOutboxState } from "./capture-outbox";

describe("nextOutboxState — retry/dead policy", () => {
  test("success → delivered, whatever the attempt", () => {
    expect(nextOutboxState(true, 0, 6)).toBe("delivered");
    expect(nextOutboxState(true, 5, 6)).toBe("delivered");
  });

  test("failure retries until maxAttempts, then dead-letters", () => {
    expect(nextOutboxState(false, 0, 6)).toBe("retry"); // → attempt 1
    expect(nextOutboxState(false, 4, 6)).toBe("retry"); // → attempt 5
    expect(nextOutboxState(false, 5, 6)).toBe("dead"); // → attempt 6 = max
    expect(nextOutboxState(false, 6, 6)).toBe("dead");
  });
});

describe("backoffAt — exponential, capped", () => {
  test("doubles per attempt from 30s", () => {
    expect(backoffAt(0, 0).getTime()).toBe(30_000);
    expect(backoffAt(0, 1).getTime()).toBe(60_000);
    expect(backoffAt(0, 3).getTime()).toBe(240_000);
  });

  test("caps at 1h", () => {
    expect(backoffAt(0, 20).getTime()).toBe(3_600_000);
  });

  test("is relative to `now`", () => {
    expect(backoffAt(1_000_000, 0).getTime()).toBe(1_030_000);
  });
});
