import { afterEach, describe, expect, test } from "bun:test";
import { finalizeRun } from "../src/runs/finalize";
import { getCapture } from "../src/memory/capture-outbox";
import { acceptRunCommand } from "../src/commands";
import { recoverStaleRuns, type ReconcileProbe } from "../src/runs/recovery";
import {
  createRun,
  getRun,
  insertStep,
  setRunEngineSession,
  setRunSandbox,
  setRunStatus,
} from "../src/runs/repo";
import { db } from "../src/db/client";
import { artifacts } from "../src/db/schema";
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
      const summary = "Summed the ledger: 42 EUR total across 7 invoices";
      await finalizeRun(id, "completed", summary, 1);
      await finalizeRun(id, "completed", summary, 1);
      const cap = await getCapture(id);
      expect(cap).not.toBeNull();
      expect(cap!.attemptCount).toBe(0); // still the original pending row
    });
  });

  test("a NON-SALIENT summary (trivial one-liner) does NOT enqueue a capture", async () => {
    await withMemory(async () => {
      const trivial = await freshRun("quick check");
      await finalizeRun(trivial, "completed", "OK", 5);
      expect((await getRun(trivial))?.status).toBe("completed");
      expect(await getCapture(trivial)).toBeNull();

      const apology = await freshRun("fetch the report");
      await finalizeRun(apology, "completed", "I'm sorry, I couldn't reach the reporting API.", 5);
      expect(await getCapture(apology)).toBeNull();
    });
  });

  test("the capture payload carries VERIFIED-outcome evidence (item 5)", async () => {
    await withMemory(async () => {
      const id = await freshRun("build the quarterly report");
      await insertStep({ runId: id, idx: 0, kind: "command", label: "Running Command", chip: "script", code: null });
      await insertStep({ runId: id, idx: 1, kind: "file", label: "Editing file", chip: "file", code: null });
      await insertStep({ runId: id, idx: 2, kind: "done", label: "Done", chip: null, code: null });
      await db.insert(artifacts).values({
        orgId: ORG,
        runId: id,
        threadId: id,
        sourcePath: "/work/report.pdf",
        name: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 1024,
        sha256: "a".repeat(64),
        storageKey: `test/${id}/report.pdf`,
      });

      await finalizeRun(id, "completed", "Built the Q3 report with revenue and churn charts", 42_000);
      const cap = await getCapture(id);
      expect(cap).not.toBeNull();
      const payload = JSON.parse(cap!.payload) as {
        evidence: {
          source: string; status: string; engine: string; model: string; durationMs: number;
          toolCounts: Record<string, number>; artifacts: Array<{ name: string; kind: string }>;
          userCorrection?: boolean;
        };
      };
      expect(payload.evidence.source).toBe("run");
      expect(payload.evidence.status).toBe("completed");
      expect(payload.evidence.engine).toBe("mock");
      expect(payload.evidence.model).toBe("claude-opus-5");
      expect(payload.evidence.durationMs).toBe(42_000);
      expect(payload.evidence.toolCounts).toEqual({ command: 1, file: 1 }); // `done` excluded
      expect(payload.evidence.artifacts).toEqual([{ name: "report.pdf", kind: "application/pdf" }]);
      expect(payload.evidence.userCorrection).toBeUndefined(); // a thread root is never a correction
    });
  });

  test("a reply to a FAILED parent captures the user-correction signal", async () => {
    await withMemory(async () => {
      const parentId = await freshRun("deploy to staging");
      await finalizeRun(parentId, "failed", "engine error", 100);

      const replyId = crypto.randomUUID();
      await createRun({ id: replyId, prompt: "please retry the deploy", model: "claude-opus-5", engine: "mock", orgId: ORG, userId: null, parentRunId: parentId, threadId: parentId });
      await finalizeRun(replyId, "completed", "Deployed to staging on the second attempt, healthchecks green", 9_000);

      const cap = await getCapture(replyId);
      expect(cap).not.toBeNull();
      const payload = JSON.parse(cap!.payload) as { evidence: { userCorrection?: boolean } };
      expect(payload.evidence.userCorrection).toBe(true);
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
        h.sessionId === "ses_done"
          ? { status: "completed", summary: "Reconciled after restart: the session finished with 3 edits" }
          : { status: "unreachable" };
      const res = await recoverStaleRuns(reconcile);
      expect(res.reconciled).toBeGreaterThanOrEqual(1);

      expect((await getRun(id))?.status).toBe("completed");
      const cap = await getCapture(id);
      expect(cap).not.toBeNull();
      expect((JSON.parse(cap!.payload) as { summary: string }).summary).toBe(
        "Reconciled after restart: the session finished with 3 edits",
      );
    });
  });
});
