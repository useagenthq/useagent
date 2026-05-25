import { afterEach, describe, expect, test } from "bun:test";
import { finalizeRun } from "../src/runs/finalize";
import { getCapture } from "../src/memory/capture-outbox";
import { acceptRunCommand } from "../src/commands";
import { recoverStaleRuns, type ReconcileProbe } from "../src/runs/recovery";
import {
  createRun,
  getRun,
  setRunEngineSession,
  setRunSandbox,
  setRunStatus,
} from "../src/runs/repo";
import { db } from "../src/db/client";
import { sql } from "drizzle-orm";
import "./helpers"; // side-effect: imports src/index → migrate + seed

// Regression for GAP 2: a completed run could miss its memory capture. The
// capture used to be enqueued AFTER completeRun (a crash in that gap lost it) and
// the boot-reconcile + mock paths never enqueued at all. finalizeRun now commits
// `completed` AND the capture row in ONE transaction, for EVERY completed run.

const ORG = "org-skynet-dev";

/** Run `fn` with team memory configured (identity resolves), then restore env. */
async function withMemory<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.MEMORY_API_URL;
  process.env.MEMORY_API_URL = "http://memory.invalid"; // enqueue never calls the network
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.MEMORY_API_URL;
    else process.env.MEMORY_API_URL = prev;
  }
}

async function freshRun(prompt = "capture me", origin: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await createRun({ id, prompt, model: "claude-opus-5", engine: "mock", orgId: ORG, userId: null, parentRunId: null, threadId: id, origin });
  return id;
}

afterEach(() => {
  delete process.env.MEMORY_API_URL; // never leak the flag to other test files
});

describe("finalizeRun — transactional memory capture (GAP 2)", () => {
  test("a completed run enqueues its capture atomically with completion", async () => {
    await withMemory(async () => {
      const id = await freshRun("what is the canary id");
      await finalizeRun(id, "completed", "the answer is RC-42", 1234);

      const run = await getRun(id);
      expect(run?.status).toBe("completed");
      expect(run?.summary).toBe("the answer is RC-42");

      const cap = await getCapture(id);
      expect(cap).not.toBeNull();
      expect(cap!.state).toBe("pending");
      const payload = JSON.parse(cap!.payload) as { prompt: string; summary: string };
      expect(payload.prompt).toBe("what is the canary id");
      expect(payload.summary).toBe("the answer is RC-42");
    });
  });

  test("an INTERNAL run (canary/e2e origin) does NOT enqueue a capture", async () => {
    await withMemory(async () => {
      const id = await freshRun("t3 parity probe: list the repo files", "t3-parity");
      await finalizeRun(id, "completed", "Listed 14 files across src and test directories", 500);
      expect((await getRun(id))?.status).toBe("completed");
      expect(await getCapture(id)).toBeNull();
    });
  });

  test("a failed run does NOT enqueue a capture", async () => {
    await withMemory(async () => {
      const id = await freshRun();
      await finalizeRun(id, "failed", "engine error", 0);
      expect((await getRun(id))?.status).toBe("failed");
      expect(await getCapture(id)).toBeNull();
    });
  });

  test("memory disabled → completes but enqueues nothing (clean no-op)", async () => {
    delete process.env.MEMORY_API_URL; // gate off
    const id = await freshRun();
    await finalizeRun(id, "completed", "done", 10);
    expect((await getRun(id))?.status).toBe("completed");
    expect(await getCapture(id)).toBeNull();
  });

  test("enqueue is idempotent — finalizing twice yields one capture row", async () => {
    await withMemory(async () => {
      const id = await freshRun();
      await finalizeRun(id, "completed", "sum", 1);
      await finalizeRun(id, "completed", "sum", 1);
      const cap = await getCapture(id);
      expect(cap).not.toBeNull();
      expect(cap!.attemptCount).toBe(0); // still the original pending row
    });
  });

  test("a BOOT-RECONCILED run enqueues its capture (incl. boot-reconciled ones)", async () => {
    await withMemory(async () => {
      // An opencode run, running, command dispatched, whose native session
      // finished server-side — recovery reconciles it to completed via finalizeRun.
      const id = crypto.randomUUID();
      await acceptRunCommand({
        idempotencyKey: null, orgId: ORG, actorId: null,
        run: { id, prompt: "reconcile + capture", model: "claude-opus-5", engine: "opencode", parentRunId: null, threadId: id },
      });
      await setRunStatus(id, "running");
      await setRunEngineSession(id, "ses_done");
      await setRunSandbox(id, "sb");
      await db.execute(sql`update commands set state='dispatched' where run_id=${id} and kind='run.create'`);

      const reconcile: ReconcileProbe = async (h) =>
        h.sessionId === "ses_done" ? { status: "completed", summary: "reconciled answer" } : { status: "unreachable" };
      const res = await recoverStaleRuns(reconcile);
      expect(res.reconciled).toBeGreaterThanOrEqual(1);

      expect((await getRun(id))?.status).toBe("completed");
      const cap = await getCapture(id);
      expect(cap).not.toBeNull();
      expect((JSON.parse(cap!.payload) as { summary: string }).summary).toBe("reconciled answer");
    });
  });
});
