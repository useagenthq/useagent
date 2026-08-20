// Durable learning outbox (self_improving 6.1 / 6.4). Proves the crash window
// between run completion and learning-candidate creation is closed: the intent
// row is written INSIDE finalizeRun's terminal transaction, and a boot-started
// worker builds the candidate off that committed row — retryable, dead-lettering,
// and it never fails an already-completed run. Also proves the verified-outcome
// gate (6.4): an unverified completion enqueues an intent but produces NO
// procedure candidate. DB-backed (skynet_test).

import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { artifacts, knowledgeDrafts, learningOutbox, steps } from "../src/db/schema";
import { finalizeRun } from "../src/runs/finalize";
import { createRun, insertStep } from "../src/runs/repo";
import {
  enqueueLearning,
  getLearningIntent,
  nextLearningStatus,
  processDueLearning,
  resetStuckLearning,
} from "../src/learning/learning-outbox";
import "./helpers"; // side-effect: imports src/index -> migrate + seed

const ORG = "org-skynet-dev";

async function freshRun(
  prompt = "build something",
  opts: { origin?: string | null; engine?: string; parentRunId?: string | null } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await createRun({
    id,
    prompt,
    model: "claude-opus-5",
    engine: opts.engine ?? "mock",
    orgId: ORG,
    userId: null,
    parentRunId: opts.parentRunId ?? null,
    threadId: id,
    origin: opts.origin ?? null,
  });
  return id;
}

/** Give a run a durable, VERIFIED procedure: >= 3 executable steps across 2+
 *  tools INCLUDING a verification step (bun test), so the verified-outcome gate
 *  passes without a published artifact. */
async function seedVerifiedProcedure(runId: string): Promise<void> {
  await insertStep({ runId, idx: 0, kind: "command", label: "bun install", chip: "bash", code: { tool: "bash", input: { command: "bun install" } } });
  await insertStep({ runId, idx: 1, kind: "file", label: "edit src/x.ts", chip: "file", code: { tool: "edit", input: { filePath: "src/x.ts" } } });
  await insertStep({ runId, idx: 2, kind: "command", label: "bun test", chip: "bash", code: { tool: "bash", input: { command: "bun test" } } });
  await insertStep({ runId, idx: 3, kind: "done", label: "Done", chip: null, code: null });
}

afterEach(async () => {
  // Keep the shared dev DB tidy between tests (rows are org-scoped test runs).
  await db.delete(learningOutbox).where(eq(learningOutbox.orgId, ORG));
});

describe("learning outbox — enqueue is inside finalizeRun's terminal transaction", () => {
  test("a completed non-internal run enqueues a PENDING learning intent atomically", async () => {
    const id = await freshRun();
    await finalizeRun(id, "completed", "Did the multi-step thing", 5_000);

    const intent = await getLearningIntent(id);
    expect(intent).not.toBeNull();
    expect(intent!.status).toBe("pending");
    expect(intent!.orgId).toBe(ORG);
    expect(intent!.policyVersion).toBe(1);
    // No candidate is built yet — that is the worker's job (post-commit).
    const [draft] = await db.select().from(knowledgeDrafts).where(eq(knowledgeDrafts.runId, id));
    expect(draft).toBeUndefined();
  });

  test("a FAILED run enqueues NO learning intent", async () => {
    const id = await freshRun();
    await finalizeRun(id, "failed", "engine error", 0);
    expect(await getLearningIntent(id)).toBeNull();
  });

  test("an INTERNAL-origin run enqueues NO learning intent (no eval traffic)", async () => {
    const id = await freshRun("parity probe", { origin: "t3-parity" });
    await finalizeRun(id, "completed", "Listed files across the repo tree", 500);
    expect(await getLearningIntent(id)).toBeNull();
  });

  test("re-finalizing is idempotent — one intent row, not two", async () => {
    const id = await freshRun();
    await finalizeRun(id, "completed", "Did the thing", 1_000);
    await finalizeRun(id, "completed", "Did the thing", 1_000);
    const rows = await db.select().from(learningOutbox).where(eq(learningOutbox.runId, id));
    expect(rows).toHaveLength(1);
  });
});

describe("learning outbox — the worker builds the candidate exactly once (crash safety)", () => {
  test("crash AFTER commit BEFORE processing -> candidate created exactly once on worker run", async () => {
    // Simulate the crash: finalize commits the intent (+ run) but the process
    // dies before the worker ticks. On restart the worker claims the committed
    // intent and builds the candidate. Running it TWICE must still yield ONE.
    const id = await freshRun("publish the quarterly report");
    await seedVerifiedProcedure(id);
    // A published artifact makes it unambiguously verified + high-value.
    await db.insert(artifacts).values({
      orgId: ORG,
      runId: id,
      threadId: id,
      sourcePath: "/work/report.pdf",
      name: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
      sha256: "b".repeat(64),
      storageKey: `test/${id}/report.pdf`,
    });
    await finalizeRun(id, "completed", "Built the Q3 report with charts", 30_000);

    // The intent is committed and pending; no draft yet (the "crash").
    expect((await getLearningIntent(id))!.status).toBe("pending");
    expect(
      (await db.select().from(knowledgeDrafts).where(eq(knowledgeDrafts.runId, id))).length,
    ).toBe(0);

    // Worker restart: process the due intent.
    const first = await processDueLearning();
    expect(first.built).toBe(1);
    expect((await getLearningIntent(id))!.status).toBe("done");

    const drafts1 = await db.select().from(knowledgeDrafts).where(eq(knowledgeDrafts.runId, id));
    expect(drafts1).toHaveLength(1);
    // The draft carries the Evidence-Model-v2 procedure (6.2).
    expect(drafts1[0]!.evidence.procedureV2?.length ?? 0).toBeGreaterThan(0);
    expect(drafts1[0]!.evidence.verified).toBe(true);

    // Running the worker AGAINST an already-done row does nothing; the draft
    // is idempotent (one per run) even if the row were somehow re-armed.
    const second = await processDueLearning();
    expect(second.built + second.skipped).toBe(0); // nothing pending
    const drafts2 = await db.select().from(knowledgeDrafts).where(eq(knowledgeDrafts.runId, id));
    expect(drafts2).toHaveLength(1); // STILL exactly one
  });

  test("the built draft's v2 procedure preserves order + repeats and excludes failures", async () => {
    const id = await freshRun("run a repeated build");
    await insertStep({ runId: id, idx: 0, kind: "command", label: "bun install", chip: "bash", code: { tool: "bash", input: { command: "bun install" } } });
    await insertStep({ runId: id, idx: 1, kind: "command", label: "bun test", chip: "bash", code: { tool: "bash", input: { command: "bun test" }, error: true } });
    await insertStep({ runId: id, idx: 2, kind: "command", label: "bun install", chip: "bash", code: { tool: "bash", input: { command: "bun install" } } });
    await insertStep({ runId: id, idx: 3, kind: "command", label: "bun test", chip: "bash", code: { tool: "bash", input: { command: "bun test" } } });
    await insertStep({ runId: id, idx: 4, kind: "done", label: "Done", chip: null, code: null });
    // A published artifact makes the run high-value (salience) AND verified.
    await db.insert(artifacts).values({
      orgId: ORG,
      runId: id,
      threadId: id,
      sourcePath: "/work/out.txt",
      name: "out.txt",
      contentType: "text/plain",
      sizeBytes: 12,
      sha256: "c".repeat(64),
      storageKey: `test/${id}/out.txt`,
    });
    await finalizeRun(id, "completed", "Recovered a flaky build and shipped it", 12_000);
    await processDueLearning();

    const [draft] = await db.select().from(knowledgeDrafts).where(eq(knowledgeDrafts.runId, id));
    const exec = draft!.evidence.procedureV2!;
    // Order + repeats preserved; the FAILED bun test is excluded from executable.
    expect(exec.map((s) => s.operation)).toEqual(["bun install", "bun install", "bun test"]);
    // The failed step is retained as advice.
    expect(draft!.evidence.advice?.some((s) => s.result === "failed")).toBe(true);
  });
});

describe("verified-outcome gate (6.4) at build time", () => {
  test("an UNVERIFIED long completion enqueues an intent but produces NO candidate", async () => {
    // Long multi-tool run (salience high-value) but NO artifact and NO
    // verification step -> the gate rejects the procedure candidate.
    const id = await freshRun("do a lot of unverified work");
    for (let i = 0; i < 12; i++) {
      const kind = i % 2 === 0 ? "command" : "file";
      await insertStep({ runId: id, idx: i, kind, label: `step ${i}`, chip: kind === "command" ? "bash" : "file", code: { tool: kind === "command" ? "bash" : "edit", input: { command: `echo ${i}` } } });
    }
    await insertStep({ runId: id, idx: 12, kind: "done", label: "Done", chip: null, code: null });
    await finalizeRun(id, "completed", "Poked around a lot without verifying anything", 20_000);

    // Intent enqueued...
    expect((await getLearningIntent(id))!.status).toBe("pending");
    // ...but the worker produces no candidate (a clean skip, marked done).
    const res = await processDueLearning();
    expect(res.built).toBe(0);
    expect(res.skipped).toBe(1);
    expect((await getLearningIntent(id))!.status).toBe("done");
    expect(
      (await db.select().from(knowledgeDrafts).where(eq(knowledgeDrafts.runId, id))).length,
    ).toBe(0);
  });
});

describe("delivery worker — retry / dead-letter policy", () => {
  test("nextLearningStatus: ok -> done; failure -> retry until maxAttempts, then dead", () => {
    expect(nextLearningStatus(true, 0, 6)).toBe("done");
    expect(nextLearningStatus(false, 0, 6)).toBe("retry");
    expect(nextLearningStatus(false, 5, 6)).toBe("dead");
  });

  test("a build error RETRIES with an operator-visible reason, then DEAD-LETTERS", async () => {
    const throwingBuild = async () => {
      throw new Error("simulated build failure");
    };

    // First failure on a fresh row -> retry (status back to pending, attempts++,
    // last_error recorded, next_attempt_at pushed out by backoff).
    const idRetry = await freshRun("retry me");
    await enqueueLearning({ runId: idRetry, orgId: ORG, userId: null, memoryScope: "org", origin: null });
    const r1 = await processDueLearning(20, throwingBuild);
    expect(r1.retried).toBe(1);
    const retried = await getLearningIntent(idRetry);
    expect(retried!.status).toBe("pending");
    expect(retried!.attempts).toBe(1);
    expect(retried!.lastError).toContain("simulated build failure");

    // A row already at the attempt ceiling -> dead (operator-visible reason).
    const idDead = await freshRun("dead-letter me");
    await enqueueLearning({ runId: idDead, orgId: ORG, userId: null, memoryScope: "org", origin: null });
    await db.update(learningOutbox).set({ attempts: 5, maxAttempts: 6 }).where(eq(learningOutbox.runId, idDead));
    const r2 = await processDueLearning(20, throwingBuild);
    expect(r2.dead).toBe(1);
    const dead = await getLearningIntent(idDead);
    expect(dead!.status).toBe("dead");
    expect(dead!.lastError).toContain("after max attempts");
  });
});

describe("boot recovery — a crash-orphaned processing row is re-armed", () => {
  test("resetStuckLearning flips processing rows back to pending (idempotent build)", async () => {
    const id = await freshRun();
    await enqueueLearning({ runId: id, orgId: ORG, userId: null, memoryScope: "org", origin: null });
    await db.update(learningOutbox).set({ status: "processing" }).where(eq(learningOutbox.runId, id));
    const n = await resetStuckLearning();
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await getLearningIntent(id))!.status).toBe("pending");
  });
});
