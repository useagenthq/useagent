import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { acceptRunCommand } from "../src/commands";
import { claimNextRun, settleCommandForRun } from "../src/commands/dispatch";
import { completeRun } from "../src/runs/repo";
import { waitFor } from "./helpers"; // side-effect: imports src/index → migrate + seed

// Mailbox primitives for the durable per-session command lane. These drive the
// claim/settle CAS directly (no worker execution) so ordering, one-in-flight,
// idempotency, and cross-thread independence are asserted deterministically.

const ORG = "org-skynet-dev";

/** Enqueue a run.create command (state queued, run queued) without dispatching. */
async function enqueue(threadId: string, parentRunId: string | null): Promise<string> {
  const id = threadId && parentRunId === null ? threadId : crypto.randomUUID();
  const out = await acceptRunCommand({
    idempotencyKey: null,
    orgId: ORG,
    actorId: null,
    run: { id, prompt: "x", model: "claude-opus-5", engine: "mock", parentRunId, threadId },
  });
  expect(out.status).toBe("created");
  return id;
}

/** Retire a thread's commands so they don't pollute a later boot reconcile. */
async function retire(threadId: string): Promise<void> {
  await db.execute(sql`update commands set state='completed' where thread_id=${threadId}`);
}

describe("durable command lane", () => {
  test("per-thread: strict order + at most one command in flight", async () => {
    const T = crypto.randomUUID();
    await enqueue(T, null); // root A, run id === thread id === T
    const B = await enqueue(T, T); // reply

    // Head A dispatches; a second claim is refused while A is in flight.
    expect(await claimNextRun(T)).toBe(T);
    expect(await claimNextRun(T)).toBeNull();

    // A finishes → its command settles → the NEXT turn (B) can dispatch, in order.
    await completeRun(T, "completed", "done", 1);
    expect((await settleCommandForRun(T)).status).toBe("completed");
    expect(await claimNextRun(T)).toBe(B);
    expect(await claimNextRun(T)).toBeNull(); // B now in flight

    await retire(T);
  });

  test("concurrent claims dispatch a command AT MOST once (idempotent CAS)", async () => {
    const T = crypto.randomUUID();
    await enqueue(T, null);

    const [r1, r2] = await Promise.all([claimNextRun(T), claimNextRun(T)]);
    expect([r1, r2].filter((x) => x === T)).toHaveLength(1);
    expect([r1, r2].filter((x) => x === null)).toHaveLength(1);

    await retire(T);
  });

  test("different threads dispatch concurrently (queues never serialize)", async () => {
    const T1 = crypto.randomUUID();
    const T2 = crypto.randomUUID();
    await enqueue(T1, null);
    await enqueue(T2, null);

    const [r1, r2] = await Promise.all([claimNextRun(T1), claimNextRun(T2)]);
    expect(r1).toBe(T1);
    expect(r2).toBe(T2);

    await retire(T1);
    await retire(T2);
  });

  test("settleCommandForRun requeues a run whose worker never started", async () => {
    const T = crypto.randomUUID();
    await enqueue(T, null);
    expect(await claimNextRun(T)).toBe(T); // dispatched, but run stays queued

    // Worker died before setting the run running → the command requeues.
    expect((await settleCommandForRun(T)).status).toBe("requeued");
    // ...so it can be claimed again (re-dispatch).
    expect(await claimNextRun(T)).toBe(T);

    await retire(T);
  });
});
