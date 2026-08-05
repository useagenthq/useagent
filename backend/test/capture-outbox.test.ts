import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import {
  backoffAt,
  deliverDueCaptures,
  enqueueCapture,
  getCapture,
  nextOutboxState,
} from "../src/memory/capture-outbox";
import type { MemoryIdentity } from "../src/memory/team-memory";
import { uid } from "./helpers";

// Durable capture outbox — the memory-scope requirement here is spec test 10:
// a retried delivery must preserve the run's ORIGINAL destination pool. Delivery
// is forced to fail (fetch throws) so the row keeps retrying; the committed
// payload — which a retry reuses verbatim — must still name the same pool.
// `fetch` is mocked so nothing hits the real memory gateway.

const realFetch = globalThis.fetch;

/** A PERSONAL-pool destination: user_id IS the actor; team_id = orgId. */
function personalIdentity(user: string): MemoryIdentity {
  return {
    teamId: "org-1",
    agentId: "skynet-backend",
    userId: user,
    actorUserId: user,
    sessionId: "thread-1",
    runId: "run-x",
  };
}

const forceDue = (id: string) =>
  db.execute(sql`update memory_outbox set next_attempt_at = now() - interval '1 second' where id = ${id}`);

beforeEach(async () => {
  await db.execute(sql`delete from memory_outbox`);
  // Memory enabled so deliverTeamMemory actually attempts + reports failure.
  process.env.MEMORY_API_URL = "http://memory.test:8420";
  process.env.MEMORY_API_KEY = "sk-mem-test";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("capture-outbox retry preserves the destination scope (spec test 10)", () => {
  test("a failed PERSONAL capture retries into the SAME personal pool, never org", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const runId = uid("cap");
    await enqueueCapture(runId, personalIdentity("alice"), { prompt: "p", summary: "s" }, "personal");

    // attempt 1 → retry
    let res = await deliverDueCaptures();
    expect(res.retried).toBe(1);
    let row = await getCapture(runId);
    expect(row?.state).toBe("pending");
    expect(row?.attemptCount).toBe(1);
    let payload = JSON.parse(String(row?.payload));
    expect(payload.scope).toBe("personal");
    expect(payload.identity.userId).toBe("alice"); // the personal pool
    expect(payload.identity.userId).not.toBe("org:org-1");

    // attempt 2 → destination preserved across the retry
    await forceDue(runId);
    res = await deliverDueCaptures();
    expect(res.retried).toBe(1);
    row = await getCapture(runId);
    expect(row?.attemptCount).toBe(2);
    payload = JSON.parse(String(row?.payload));
    expect(payload.scope).toBe("personal");
    expect(payload.identity.userId).toBe("alice");
  });

  test("an ORG capture retries into the org pool (never a personal one)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const runId = uid("cap-org");
    const orgIdentity: MemoryIdentity = {
      teamId: "org-1",
      agentId: "skynet-backend",
      userId: "org:org-1",
      actorUserId: "alice",
      sessionId: "t",
      runId,
    };
    await enqueueCapture(runId, orgIdentity, { prompt: "p", summary: "s" }, "org");
    await deliverDueCaptures();
    const payload = JSON.parse(String((await getCapture(runId))?.payload));
    expect(payload.scope).toBe("org");
    expect(payload.identity.userId).toBe("org:org-1");
  });

  test("enqueue is idempotent by runId — a second enqueue never rewrites the destination", async () => {
    globalThis.fetch = (async () => {
      throw new Error("x");
    }) as unknown as typeof fetch;
    const runId = uid("cap-idem");
    await enqueueCapture(runId, personalIdentity("alice"), { prompt: "p", summary: "s" }, "personal");
    // A duplicate finalization with a DIFFERENT destination must be ignored.
    await enqueueCapture(
      runId,
      { teamId: "org-1", agentId: "skynet-backend", userId: "org:org-1", actorUserId: "m", sessionId: "t", runId },
      { prompt: "p2", summary: "s2" },
      "org",
    );
    const payload = JSON.parse(String((await getCapture(runId))?.payload));
    expect(payload.identity.userId).toBe("alice"); // first enqueue wins
    expect(payload.scope).toBe("personal");
  });
});

describe("capture-outbox pure policy", () => {
  test("nextOutboxState: ok → delivered; fail before max → retry; fail at max → dead", () => {
    expect(nextOutboxState(true, 0, 6)).toBe("delivered");
    expect(nextOutboxState(false, 0, 6)).toBe("retry");
    expect(nextOutboxState(false, 5, 6)).toBe("dead");
  });
  test("backoffAt: exponential (30s·2^n), capped at 1h", () => {
    const t0 = 1_000_000;
    expect(backoffAt(t0, 0).getTime()).toBe(t0 + 30_000);
    expect(backoffAt(t0, 1).getTime()).toBe(t0 + 60_000);
    expect(backoffAt(t0, 100).getTime()).toBe(t0 + 3_600_000); // capped
  });
});
